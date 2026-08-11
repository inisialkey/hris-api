import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { cycleConflicts } from '../domain/overlap';
import { shiftErrors } from '../domain/shift.errors';
import {
  PATTERN_REPOSITORY,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_REPOSITORY,
  type PatternRepositoryPort,
  type RosterDayRepositoryPort,
  type ScheduleCachePort,
  type ShiftOutboxPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { Page, Paged, ShiftRow } from '../domain/shift.types';
import { addDays, paidMinutes, spanMinutes, crossesMidnight, minutesOfDay } from '../domain/time';
import { WriteGuards } from './write-guards';

export type CreateShiftInput = Omit<ShiftRow, 'id'>;
export type UpdateShiftInput = Partial<Omit<ShiftRow, 'id' | 'companyId' | 'code'>>;

/** §7's list row — the stored shift plus what the grid computes from it. */
export interface ShiftListRow extends ShiftRow {
  crossesMidnight: boolean;
  spanMinutes: number;
  paidMinutes: number;
  usageCount: number;
}

/** §7's `usageCount` horizon: *"live pattern entries + future roster days"*, 30 days out. */
const USAGE_HORIZON_DAYS = 30;

/** §8's bounds. */
const MAX_TOLERANCE_MINUTES = 240;
const MAX_WINDOW_MINUTES = 720;

/**
 * UC-SHF-002 — define a shift.
 *
 * The order is the interesting part: **shape** (§8), then the **window-overlap
 * re-check** across every pattern and future roster day already using the shift
 * (BR-SHF-006), then the **period lock** (BR-SHF-009). A time change is a
 * working-hours change, which is why the edit is re-checked against rosters that
 * were valid before it rather than only against the form.
 */
@Injectable()
export class ShiftDefinitionService {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(PATTERN_REPOSITORY) private readonly patterns: PatternRepositoryPort,
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(SHIFT_OUTBOX) private readonly outbox: ShiftOutboxPort,
    private readonly guards: WriteGuards,
  ) {}

  async list(
    filter: { companyId: string; q?: string },
    page: Page,
  ): Promise<Result<Paged<ShiftListRow>>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const found = await this.shifts.list(filter, page);
    const today = this.guards.today();
    const usage = await this.shifts.usageCounts(
      found.rows.map((row) => row.id),
      today,
      addDays(today, USAGE_HORIZON_DAYS),
    );

    return ok({
      total: found.total,
      rows: found.rows.map((row) => ({
        ...row,
        crossesMidnight: crossesMidnight(row),
        spanMinutes: spanMinutes(row),
        paidMinutes: paidMinutes(row),
        usageCount: usage.get(row.id) ?? 0,
      })),
    });
  }

  async create(input: CreateShiftInput): Promise<Result<ShiftRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    const shape = validateTimes(input);
    if (!shape.ok) return shape;

    if (await this.shifts.findByCode(input.companyId, input.code)) {
      return fail(duplicateOn('code'));
    }
    // A brand-new shift is scheduled nowhere, so there is nothing to re-check and
    // nothing locked to touch: the guards below belong to the edit path only.
    const created = await this.shifts.create(input);
    await this.announce(created.companyId, [created.id]);
    return ok(created);
  }

  async update(id: string, patch: UpdateShiftInput): Promise<Result<ShiftRow>> {
    const existing = await this.shifts.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const merged = { ...existing, ...patch };
    const shape = validateTimes(merged);
    if (!shape.ok) return shape;

    const timesChanged =
      merged.startTime !== existing.startTime ||
      merged.endTime !== existing.endTime ||
      merged.punchInBeforeMinutes !== existing.punchInBeforeMinutes ||
      merged.punchOutAfterMinutes !== existing.punchOutAfterMinutes;

    if (timesChanged) {
      const conflict = await this.rescheduleConflict(merged);
      if (conflict) return conflict;

      // BR-SHF-009 — every date this shift is already scheduled on, because a
      // time change re-interprets each of them. Explicit rows give exact dates;
      // a pattern-scheduled date inside a locked period is caught through the
      // roster days that pattern produced rows for, which is the bounded set the
      // lock can actually be asked about.
      const usage = await this.rosterDays.usage(id);
      const unlocked = await this.guards.requireUnlocked(
        existing.companyId,
        usage.map((row) => row.date),
      );
      if (!unlocked.ok) return unlocked;
    }

    const updated = await this.shifts.update(id, patch);
    if (!updated) return fail(sharedErrors.notFound());
    await this.announce(updated.companyId, [updated.id]);
    return ok(updated);
  }

  /** BR-SHF-011 — archive is blocked by live pattern entries and live/future roster days. */
  async archive(id: string): Promise<Result<{ id: string }>> {
    const existing = await this.shifts.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const blockers = await this.shifts.archiveBlockers(id, this.guards.today());
    if (blockers.length > 0) return fail(shiftErrors.inUse({ blockers }));

    await this.shifts.archive(id);
    await this.announce(existing.companyId, [id]);
    return ok({ id });
  }

  /**
   * The edit's blast radius: every pattern whose cycle uses this shift, re-run
   * with the new times, and every **future** roster day it is scheduled on
   * against that day's neighbours.
   */
  private async rescheduleConflict(merged: ShiftRow): Promise<Result<never> | null> {
    const patterns = await this.patterns.usingShift(merged.id);
    const shifts = await this.shifts.findAllByCompany(merged.companyId);
    shifts.set(merged.id, merged); // the new times, not the stored ones

    for (const pattern of patterns) {
      const conflicts = cycleConflicts(pattern.days, pattern.cycleLength, shifts);
      const first = conflicts[0];
      if (first) {
        return fail(
          shiftErrors.windowOverlap({
            patternId: pattern.id,
            dayIndex: first.dayIndex,
            conflictingShiftId: first.conflictingShiftId,
          }),
        );
      }
    }

    const today = this.guards.today();
    for (const usage of await this.rosterDays.usage(merged.id)) {
      if (usage.date < today) continue;
      const conflict = await this.guards.neighbourConflict(usage.employeeId, usage.date, merged);
      if (conflict) {
        return fail(
          shiftErrors.windowOverlap({
            employeeId: conflict.employeeId,
            date: conflict.date,
            conflictingShiftId: conflict.conflictingShiftId,
          }),
        );
      }
    }
    return null;
  }

  /**
   * §12's `shift.definition.changed`, deliberately coarse: the affected employee
   * set is unbounded, so consumers resolve it themselves and the cache bust is
   * tenant-wide. §13 keeps notification out of this path for the same reason —
   * a definition edit is usually an announced policy change, and the edit dialog
   * carries the affected-employee count instead.
   */
  private async announce(companyId: string, shiftIds: string[]): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    await this.cache.bustTenant(tenantId);
    await this.outbox.emit({
      name: 'shift.definition.changed',
      tenantId,
      aggregateId: shiftIds[0] ?? companyId,
      payload: { companyId, shiftIds },
    });
  }
}

/** §8's shape rules for a shift, shared by create and edit. */
export function validateTimes(shift: ShiftRow | CreateShiftInput): Result<void> {
  const entries = [];
  const span = spanMinutes(shift);

  if (span === 0) entries.push(field('endTime', fieldCodes.dateRangeInvalid));
  if (shift.breakMinutes < 0 || (span > 0 && shift.breakMinutes >= span)) {
    entries.push(field('breakMinutes', fieldCodes.outOfRange, { max: span }));
  }
  for (const key of ['lateToleranceMinutes', 'earlyLeaveToleranceMinutes'] as const) {
    if (shift[key] < 0 || shift[key] > MAX_TOLERANCE_MINUTES) {
      entries.push(field(key, fieldCodes.outOfRange, { min: 0, max: MAX_TOLERANCE_MINUTES }));
    }
  }
  for (const key of ['punchInBeforeMinutes', 'punchOutAfterMinutes'] as const) {
    if (shift[key] < 0 || shift[key] > MAX_WINDOW_MINUTES) {
      entries.push(field(key, fieldCodes.outOfRange, { min: 0, max: MAX_WINDOW_MINUTES }));
    }
  }
  if (shift.breakStartTime && !insideSpan(shift, shift.breakStartTime)) {
    entries.push(field('breakStartTime', fieldCodes.outOfRange));
  }
  if (shift.code === 'OFF') entries.push(field('code', fieldCodes.invalidFormat));

  return entries.length > 0 ? fail(sharedErrors.validationFailed(entries)) : ok(undefined);
}

/** §8: inside `[start, end)`, accounting for the midnight crossing. */
function insideSpan(shift: ShiftRow | CreateShiftInput, wallTime: string): boolean {
  const offset = (minutesOfDay(wallTime) - minutesOfDay(shift.startTime) + 1440) % 1440;
  return offset < spanMinutes(shift);
}

function field(name: string, code: string, params: Record<string, unknown> = {}) {
  return { field: name, code, messageKey: `errors.${code}`, params };
}

function duplicateOn(name: string) {
  return sharedErrors.validationFailed([
    {
      field: name,
      code: fieldCodes.duplicate,
      messageKey: `errors.${fieldCodes.duplicate}`,
      params: { field: name },
    },
  ]);
}
