import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { HOLIDAY_QUERY_PORT, type HolidayQueryPort, type NonWorkingDay } from '../../holiday';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import {
  ASSIGNMENT_REPOSITORY,
  PATTERN_REPOSITORY,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_REPOSITORY,
  type AssignmentRepositoryPort,
  type PatternRepositoryPort,
  type RosterDayRepositoryPort,
  type ScheduleCachePort,
  type ShiftQueryPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { AssignmentRow, RosterDayRow, ScheduledDay, ShiftRow } from '../domain/shift.types';
import { resolveScheduledDay, type Arrangement } from '../domain/resolve';
import { addDays, datesBetween } from '../domain/time';

/** A placement as this module needs it — the branch and the zone its clock runs in. */
interface Placed {
  companyId: string;
  branchId: string;
  timezone: string;
}

/**
 * UC-SHF-001 — `ShiftQueryPort`, and the only place the ladder's inputs are
 * loaded.
 *
 * Verdicts are cached per employee-month (§4.2) because attendance derivation
 * walks a **period**, not a date: a month bucket is one build for thirty
 * questions. The bucket is busted by the four events of §12 rather than expiring
 * into staleness, and its TTL is the backstop.
 */
@Injectable()
export class ScheduleQueryService implements ShiftQueryPort {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(PATTERN_REPOSITORY) private readonly patterns: PatternRepositoryPort,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepositoryPort,
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(HOLIDAY_QUERY_PORT) private readonly holidays: HolidayQueryPort,
  ) {}

  async scheduleFor(employeeId: string, date: string): Promise<ScheduledDay> {
    const [day] = await this.scheduleRange(employeeId, date, addDays(date, 1));
    return day ?? unscheduled(date);
  }

  async scheduleRange(employeeId: string, from: string, to: string): Promise<ScheduledDay[]> {
    const tenantId = requireTenantContext().tenantId;
    const days: ScheduledDay[] = [];

    for (const month of monthsBetween(from, to)) {
      const cached = await this.cache.read(tenantId, employeeId, month);
      const bucket = cached ?? (await this.buildMonth(employeeId, month));
      if (!cached) await this.cache.write(tenantId, employeeId, month, bucket);
      days.push(...bucket.filter((day) => day.date >= from && day.date < to));
    }
    return days;
  }

  /**
   * The grid and the derivation run: one date, many employees, one query per
   * input rather than one per employee. Uncached — a page is a different shape
   * from a month, and writing thirty buckets to answer one date would evict the
   * buckets that are being used.
   */
  async scheduleForMany(employeeIds: string[], date: string): Promise<Map<string, ScheduledDay>> {
    const result = new Map<string, ScheduledDay>();
    if (employeeIds.length === 0) return result;

    const raw = await this.org.placements(employeeIds, date);
    const placements = new Map([...raw].map(([id, placement]) => [id, toPlaced(placement)]));
    const assignments = await this.assignments.liveOnForMany(employeeIds, date);
    const explicitRows = await this.rosterDays.findRangeForMany(
      employeeIds,
      date,
      addDays(date, 1),
    );
    const explicitByEmployee = new Map(explicitRows.map((row) => [row.employeeId, row]));

    const defaults = new Map<string, AssignmentRow | null>();
    const arrangements = await this.loadArrangements([...assignments.values()]);
    const shiftsById = await this.loadShifts([...placements.values()], [...assignments.values()]);

    for (const employeeId of employeeIds) {
      const placement = placements.get(employeeId) ?? null;
      const own = assignments.get(employeeId);
      let arrangement = own ? arrangements.get(own.patternId) : undefined;

      if (!own && placement) {
        // The company default, resolved once per company rather than per employee.
        if (!defaults.has(placement.companyId)) {
          defaults.set(
            placement.companyId,
            await this.assignments.defaultOn(placement.companyId, date),
          );
        }
        const fallback = defaults.get(placement.companyId) ?? null;
        if (fallback) {
          const loaded = await this.loadArrangements([fallback]);
          arrangement = loaded.get(fallback.patternId);
          if (arrangement)
            arrangement = {
              ...arrangement,
              source: 'default',
              cycleAnchorDate: fallback.cycleAnchorDate,
            };
        }
      } else if (own && arrangement) {
        arrangement = { ...arrangement, source: 'pattern', cycleAnchorDate: own.cycleAnchorDate };
      }

      const holiday = placement
        ? (await this.holidayIndex(placement, date, addDays(date, 1))).get(date)
        : undefined;

      result.set(
        employeeId,
        resolveScheduledDay({
          date,
          placement,
          explicit: toExplicit(explicitByEmployee.get(employeeId)),
          arrangement,
          holiday,
          shiftsById,
        }),
      );
    }
    return result;
  }

  /** One employee, one month — the cache's unit and the resolver's whole input set. */
  private async buildMonth(employeeId: string, month: string): Promise<ScheduledDay[]> {
    const from = `${month}-01`;
    const to = firstOfNextMonth(month);

    const assignments = await this.assignments.overlapping(employeeId, from, to);
    const explicit = await this.rosterDays.findRange(employeeId, from, to);
    const explicitByDate = new Map(explicit.map((row) => [row.date, row]));

    // Placement is asked per date because a mid-month branch transfer changes the
    // zone the same wall clock resolves in (§9), and the port answers as-of a
    // date. Thirty small indexed reads per bucket, once per bust or TTL; if that
    // ever shows up in a profile the upgrade is a placement-range port method,
    // not a cache with a coarser key.
    const placements = new Map<string, Placed | null>();
    for (const date of datesBetween(from, to)) {
      placements.set(date, toPlaced(await this.org.placement(employeeId, date)));
    }

    const defaults = new Map<string, AssignmentRow[]>();
    for (const placement of new Set(
      [...placements.values()].filter(Boolean).map((p) => p!.companyId),
    )) {
      defaults.set(placement, await this.assignments.defaultsOverlapping(placement, from, to));
    }

    const arrangements = await this.loadArrangements([
      ...assignments,
      ...[...defaults.values()].flat(),
    ]);
    const shiftsById = await this.loadShifts(
      [...placements.values()],
      [...assignments, ...[...defaults.values()].flat()],
    );
    const holidays = new Map<string, Map<string, { kind: NonWorkingDay['kind']; name: string }>>();

    const days: ScheduledDay[] = [];
    for (const date of datesBetween(from, to)) {
      const placement = placements.get(date) ?? null;
      const own = assignments.find((row) => covers(row, date));
      const fallback = placement
        ? (defaults.get(placement.companyId) ?? []).find((row) => covers(row, date))
        : undefined;
      const inForce = own ?? fallback;

      let arrangement: Arrangement | undefined;
      if (inForce) {
        const loaded = arrangements.get(inForce.patternId);
        if (loaded) {
          arrangement = {
            ...loaded,
            source: inForce.employeeId ? 'pattern' : 'default',
            cycleAnchorDate: inForce.cycleAnchorDate,
          };
        }
      }

      let holiday: { kind: NonWorkingDay['kind']; name: string } | undefined;
      if (placement) {
        const key = `${placement.companyId}:${placement.branchId}`;
        if (!holidays.has(key)) holidays.set(key, await this.holidayIndex(placement, from, to));
        holiday = holidays.get(key)?.get(date);
      }

      days.push(
        resolveScheduledDay({
          date,
          placement,
          explicit: toExplicit(explicitByDate.get(date)),
          arrangement,
          holiday,
          shiftsById,
        }),
      );
    }
    return days;
  }

  /** BR-SHF-004's input: the non-working dates of a scope, keyed by date. */
  private async holidayIndex(
    placement: Placed,
    from: string,
    to: string,
  ): Promise<Map<string, { kind: NonWorkingDay['kind']; name: string }>> {
    const nonWorking = await this.holidays.nonWorkingDays(
      placement.companyId,
      placement.branchId,
      from,
      to,
    );
    const index = new Map<string, { kind: NonWorkingDay['kind']; name: string }>();
    // First entry wins: `nonWorkingDays` is already in display priority per date
    // (holiday.md BR-HOL-002), so the leading kind is the one to render.
    for (const day of nonWorking) {
      if (!index.has(day.date)) index.set(day.date, { kind: day.kind, name: day.name });
    }
    return index;
  }

  private async loadArrangements(
    rows: readonly AssignmentRow[],
  ): Promise<Map<string, Arrangement>> {
    const ids = [...new Set(rows.map((row) => row.patternId))];
    const patterns = await this.patterns.findManyByIds(ids);
    const arrangements = new Map<string, Arrangement>();
    for (const [id, pattern] of patterns) {
      arrangements.set(id, {
        source: 'pattern',
        patternId: id,
        patternCode: pattern.code,
        cycleLength: pattern.cycleLength,
        observesHolidays: pattern.observesHolidays,
        cycleAnchorDate: '1970-01-01', // replaced by the assignment's own anchor
        days: pattern.days,
      });
    }
    return arrangements;
  }

  /**
   * Every live shift of the companies in play. A pattern entry or a roster cell
   * names a shift id, and one map answers all of them — the alternative is a
   * query per cell, which is the N+1 coding-standards §5 makes a review blocker.
   */
  private async loadShifts(
    placements: readonly (Placed | null)[],
    assignments: readonly AssignmentRow[] = [],
  ): Promise<Map<string, ShiftRow>> {
    // The company comes from the **assignment** as well as from the placement:
    // an unplaced employee still has an arrangement, and BR-SHF-008 wants
    // `off / unplaced` rather than `off / day_off`. Without the shift the ladder
    // produced, the resolver cannot tell "scheduled but unplaced" from "not
    // scheduled at all", and those are different answers to the same grid.
    const companies = [
      ...new Set([
        ...placements.filter(Boolean).map((placement) => placement!.companyId),
        ...assignments.map((assignment) => assignment.companyId),
      ]),
    ];
    const shifts = new Map<string, ShiftRow>();
    for (const companyId of companies) {
      for (const [id, row] of await this.shifts.findAllByCompany(companyId)) shifts.set(id, row);
    }
    return shifts;
  }
}

function covers(row: AssignmentRow, date: string): boolean {
  return row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo > date);
}

function toPlaced(
  placement: { companyId: string; branchId: string; branchTimezone: string } | null,
) {
  return placement
    ? {
        companyId: placement.companyId,
        branchId: placement.branchId,
        timezone: placement.branchTimezone,
      }
    : null;
}

function toExplicit(row: RosterDayRow | undefined) {
  return row
    ? { rosterDayId: row.id, shiftId: row.shiftId, worksOnHoliday: row.worksOnHoliday }
    : undefined;
}

function unscheduled(date: string): ScheduledDay {
  return { date, kind: 'off', source: 'none', offReason: 'unscheduled', standardMinutes: 0 };
}

function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let date = `${from.slice(0, 7)}-01`; date < to; date = firstOfNextMonth(date.slice(0, 7))) {
    months.push(date.slice(0, 7));
  }
  return months;
}

function firstOfNextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01-01` : `${year}-${String(index + 1).padStart(2, '0')}-01`;
}
