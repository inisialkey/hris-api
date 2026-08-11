import { Inject, Injectable } from '@nestjs/common';

import { PERIOD_LOCK_PORT, type PeriodLockPort } from '../../../shared/period-lock.port';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import {
  ASSIGNMENT_REPOSITORY,
  EMPLOYEE_LOOKUP,
  PATTERN_REPOSITORY,
  ROSTER_DAY_REPOSITORY,
  type AssignmentRepositoryPort,
  type EmployeeLookupPort,
  type PatternRepositoryPort,
  type RosterDayRepositoryPort,
} from '../domain/shift.ports';
import type { GridDay, Page } from '../domain/shift.types';
import { datesBetween } from '../domain/time';
import { ScheduleQueryService } from './schedule-query.service';

export interface GridFilter {
  companyId: string;
  from: string;
  to: string;
  branchId?: string;
  departmentId?: string;
  employeeId?: string;
  q?: string;
}

export interface GridRow {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  days: GridDay[];
}

export interface Grid {
  rows: GridRow[];
  total: number;
  lockedDates: string[];
}

/** §8: `from < to`, span ≤ 62 days. */
export const MAX_GRID_DAYS = 62;

/**
 * §7's `GET /roster-days/resolved` — the grid read, **resolution applied**,
 * including days that have no row.
 *
 * Paging is over **employees**; every page carries the full date range, which is
 * what makes a month grid one request rather than one per column. The resolver
 * runs per date over the page's employees (`scheduleForMany`), so the query count
 * is the range's length rather than the page's size times it.
 */
@Injectable()
export class RosterGridService {
  constructor(
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(PATTERN_REPOSITORY) private readonly patterns: PatternRepositoryPort,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepositoryPort,
    @Inject(PERIOD_LOCK_PORT) private readonly periods: PeriodLockPort,
    private readonly schedule: ScheduleQueryService,
  ) {}

  async resolved(filter: GridFilter, page: Page): Promise<Result<Grid>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const range = validateRange(filter.from, filter.to);
    if (!range.ok) return range;

    const employees = await this.employees.page(
      { companyId: filter.companyId, employeeId: filter.employeeId, q: filter.q },
      page,
    );
    const ids = employees.rows.map((row) => row.employeeId);
    if (ids.length === 0) return ok({ rows: [], total: employees.total, lockedDates: [] });

    const explicit = await this.rosterDays.findRangeForMany(ids, filter.from, filter.to);
    const explicitByKey = new Map(explicit.map((row) => [`${row.employeeId}:${row.date}`, row]));

    const days = new Map<string, GridDay[]>(ids.map((id) => [id, []]));
    const lockedDates: string[] = [];

    for (const date of datesBetween(filter.from, filter.to)) {
      const resolved = await this.schedule.scheduleForMany(ids, date);
      // The period selector doubles as the lock indicator (§6): a locked month
      // renders read-only cells with a tooltip rather than a failing save.
      if (await this.periods.isLocked(filter.companyId, date)) lockedDates.push(date);

      for (const id of ids) {
        const day = resolved.get(id);
        if (!day) continue;
        const row = explicitByKey.get(`${id}:${date}`);
        days.get(id)?.push({
          ...day,
          ...(row ? { rosterDayId: row.id } : {}),
        });
      }
    }

    await this.decoratePatternCodes(filter.companyId, ids, filter.from, days);

    return ok({
      total: employees.total,
      lockedDates,
      rows: employees.rows.map((employee) => ({
        employeeId: employee.employeeId,
        employeeNumber: employee.employeeNumber,
        fullName: employee.fullName,
        days: days.get(employee.employeeId) ?? [],
      })),
    });
  }

  /**
   * §6: *"cells sourced from a pattern render lighter than explicit cells, with
   * the pattern code in the tooltip — inheritance is visible"*.
   *
   * The code is read from the arrangement in force at the range's **start**:
   * enough for a tooltip, two queries for the whole page, and honest about what
   * it is — a cell whose arrangement changed mid-range still renders the code it
   * started under, which is why the tooltip is the only place it appears.
   */
  private async decoratePatternCodes(
    companyId: string,
    ids: string[],
    from: string,
    days: Map<string, GridDay[]>,
  ): Promise<void> {
    const own = await this.assignments.liveOnForMany(ids, from);
    const fallback = await this.assignments.defaultOn(companyId, from);
    const patternIds = [...own.values()].map((row) => row.patternId);
    if (fallback) patternIds.push(fallback.patternId);

    const patterns = await this.patterns.findManyByIds([...new Set(patternIds)]);

    for (const [id, cells] of days) {
      const assignment = own.get(id) ?? fallback;
      const code = assignment ? patterns.get(assignment.patternId)?.code : undefined;
      if (!code) continue;
      for (const cell of cells) {
        if (cell.source === 'pattern' || cell.source === 'default') cell.patternCode = code;
      }
    }
  }
}

export function validateRange(from: string, to: string): Result<void> {
  if (from >= to) {
    return fail(
      sharedErrors.validationFailed([
        {
          field: 'to',
          code: fieldCodes.dateRangeInvalid,
          messageKey: `errors.${fieldCodes.dateRangeInvalid}`,
          params: { from, to },
        },
      ]),
    );
  }
  if (datesBetween(from, to).length > MAX_GRID_DAYS) {
    return fail(
      sharedErrors.validationFailed([
        {
          field: 'to',
          code: fieldCodes.outOfRange,
          messageKey: `errors.${fieldCodes.outOfRange}`,
          params: { maxDays: MAX_GRID_DAYS },
        },
      ]),
    );
  }
  return ok(undefined);
}
