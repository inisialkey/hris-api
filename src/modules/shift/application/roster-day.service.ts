import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import {
  EMPLOYEE_LOOKUP,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_REPOSITORY,
  type EmployeeLookupPort,
  type RosterDayRepositoryPort,
  type ScheduleCachePort,
  type ShiftOutboxPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { RosterDayRow } from '../domain/shift.types';
import { WriteGuards } from './write-guards';

export interface PaintInput {
  employeeId: string;
  date: string;
  shiftId: string | null;
  worksOnHoliday?: boolean;
  note?: string | null;
}

export interface PaintResult {
  employeeId: string;
  date: string;
  success: boolean;
  rosterDayId?: string;
  error?: { code: string; messageKey: string };
}

/** api-standards §10 and §7: ≤ 100 items per call. */
export const BULK_LIMIT = 100;
/** §8's fat-finger guard on a painted cell. */
const MAX_YEARS_AWAY = 2;

/**
 * UC-SHF-005 — edit the roster grid.
 *
 * Painting a cell writes a `roster_days` row; clearing one deletes it and the
 * date falls back to the pattern. **A partial batch is normal** (§7): the grid
 * re-renders per cell, so a locked week or one overlapping neighbour marks its
 * own cells rather than dropping the paint everyone else asked for.
 */
@Injectable()
export class RosterDayService {
  constructor(
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(SHIFT_OUTBOX) private readonly outbox: ShiftOutboxPort,
    private readonly guards: WriteGuards,
  ) {}

  /**
   * §7's `POST /bulk-assign`, batched by **natural key** rather than by id:
   * the rows may not exist yet, which is the deviation api-standards §10 records
   * for this endpoint.
   */
  async paint(items: PaintInput[]): Promise<Result<PaintResult[]>> {
    if (items.length === 0 || items.length > BULK_LIMIT) {
      return fail(outOfRange('items', { max: BULK_LIMIT }));
    }
    const keys = new Set(items.map((item) => `${item.employeeId}:${item.date}`));
    if (keys.size !== items.length) {
      // Rejected **before any write**: two cells for one (employee, date) is a
      // client defect, and applying one of them silently would make which one
      // depend on array order.
      return fail(outOfRange('items', { duplicates: true }));
    }

    const results: PaintResult[] = [];
    const touched = new Map<string, Set<string>>();

    for (const item of items) {
      const written = await this.paintOne(item);
      if (written.ok) {
        results.push({
          employeeId: item.employeeId,
          date: item.date,
          success: true,
          rosterDayId: written.value.id,
        });
        touched.set(item.employeeId, (touched.get(item.employeeId) ?? new Set()).add(item.date));
      } else {
        results.push({
          employeeId: item.employeeId,
          date: item.date,
          success: false,
          error: { code: written.error.code, messageKey: written.error.messageKey },
        });
      }
    }

    await this.announce(touched);
    return ok(results);
  }

  /** §7's `DELETE /{id}` — the date falls back to its pattern. */
  async clear(id: string): Promise<Result<{ id: string }>> {
    const existing = await this.rosterDays.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const employee = await this.employees.find(existing.employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    const unlocked = await this.guards.requireUnlocked(employee.companyId, [existing.date]);
    if (!unlocked.ok) return unlocked;

    await this.rosterDays.softDelete(id);
    await this.announce(new Map([[existing.employeeId, new Set([existing.date])]]));
    return ok({ id });
  }

  private async paintOne(item: PaintInput): Promise<Result<RosterDayRow>> {
    const employee = await this.employees.find(item.employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    const window = this.withinWriteWindow(item.date);
    if (!window.ok) return window;

    const shift = item.shiftId
      ? ((await this.shifts.findManyByIds([item.shiftId])).get(item.shiftId) ?? null)
      : null;
    // A shift of another company is 404 rather than a validation entry — §2's
    // existence hiding, same as everywhere else here.
    if (item.shiftId && (!shift || shift.companyId !== employee.companyId)) {
      return fail(sharedErrors.notFound());
    }

    const unlocked = await this.guards.requireUnlocked(employee.companyId, [item.date]);
    if (!unlocked.ok) return unlocked;

    const neighbours = await this.guards.requireNoNeighbourConflict(
      item.employeeId,
      item.date,
      shift,
    );
    if (!neighbours.ok) return neighbours;

    return ok(
      await this.rosterDays.upsert({
        employeeId: item.employeeId,
        date: item.date,
        shiftId: item.shiftId,
        worksOnHoliday: item.worksOnHoliday ?? false,
        note: item.note ?? null,
      }),
    );
  }

  /** §8: within today ± 2 years. */
  private withinWriteWindow(date: string): Result<void> {
    const today = this.guards.today();
    const yearsAway = Math.abs(Number(date.slice(0, 4)) - Number(today.slice(0, 4)));
    return yearsAway <= MAX_YEARS_AWAY
      ? ok(undefined)
      : fail(outOfRange('date', { maxYears: MAX_YEARS_AWAY }));
  }

  /**
   * §12: **one event per mutation batch**, carrying every employee and date it
   * touched — which is what lets §13's notification batch to one message per
   * employee instead of one per painted cell.
   */
  private async announce(touched: Map<string, Set<string>>): Promise<void> {
    if (touched.size === 0) return;

    const tenantId = requireTenantContext().tenantId;
    const employeeIds = [...touched.keys()];
    const dates = [...new Set([...touched.values()].flatMap((set) => [...set]))].sort();

    await this.cache.bustEmployees(tenantId, employeeIds);
    await this.outbox.emit({
      name: 'shift.roster.changed',
      tenantId,
      aggregateId: employeeIds[0] ?? '',
      payload: { employeeIds, dates },
    });
  }
}

function outOfRange(field: string, params: Record<string, unknown>) {
  return sharedErrors.validationFailed([
    { field, code: fieldCodes.outOfRange, messageKey: `errors.${fieldCodes.outOfRange}`, params },
  ]);
}
