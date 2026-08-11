import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { PERIOD_LOCK_PORT, type PeriodLockPort } from '../../../shared/period-lock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { shiftErrors } from '../domain/shift.errors';
import type { ShiftRow } from '../domain/shift.types';
import { addDays, instantsFor } from '../domain/time';
import { ScheduleQueryService } from './schedule-query.service';

export interface WindowConflict {
  employeeId: string;
  date: string;
  conflictingShiftId: string;
}

/**
 * The two guards every write in this module runs, in one place because four
 * services run them and a fifth (the import row handler) has to run exactly the
 * same ones — UC-SHF-006: *"each row runs the same validation as a UI write"*.
 */
@Injectable()
export class WriteGuards {
  constructor(
    @Inject(PERIOD_LOCK_PORT) private readonly periods: PeriodLockPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly schedule: ScheduleQueryService,
  ) {}

  today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  /** BR-SHF-009. An empty date list passes — there is nothing to freeze. */
  async requireUnlocked(companyId: string, dates: readonly string[]): Promise<Result<void>> {
    if (dates.length === 0) return ok(undefined);
    const locked = await this.periods.firstLockedDate(companyId, [...new Set(dates)]);
    return locked
      ? fail(shiftErrors.periodLocked({ date: locked.date, periodId: locked.periodId }))
      : ok(undefined);
  }

  /**
   * BR-SHF-006 at a single cell: the incoming shift against **the resolved
   * neighbour days**, not against whatever rows happen to exist. The neighbours
   * may come from an explicit row, a pattern, or the company default, and a check
   * that looked only at `roster_days` would miss the pattern that schedules the
   * night before.
   *
   * The comparison is on UTC instants rather than on wall-clock minutes, which is
   * what makes it correct across a branch transfer: two windows that do not
   * overlap in local time do not overlap in UTC either, and the resolver has
   * already applied each date's own timezone.
   */
  async neighbourConflict(
    employeeId: string,
    date: string,
    incoming: ShiftRow | null,
  ): Promise<WindowConflict | null> {
    if (!incoming) return null;

    const placement = await this.org.placement(employeeId, date);
    if (!placement) return null; // unplaced days resolve `off`; there is no window to collide

    const window = instantsFor(date, incoming, placement.branchTimezone);
    const previous = await this.schedule.scheduleFor(employeeId, addDays(date, -1));
    const next = await this.schedule.scheduleFor(employeeId, addDays(date, 1));

    if (previous.shift && previous.shift.windowTo > window.windowFrom) {
      return { employeeId, date, conflictingShiftId: previous.shift.id };
    }
    if (next.shift && window.windowTo > next.shift.windowFrom) {
      return { employeeId, date, conflictingShiftId: next.shift.id };
    }
    return null;
  }

  /** The same check as a `Result`, for the single-cell callers. */
  async requireNoNeighbourConflict(
    employeeId: string,
    date: string,
    incoming: ShiftRow | null,
  ): Promise<Result<void>> {
    const conflict = await this.neighbourConflict(employeeId, date, incoming);
    return conflict
      ? fail(
          shiftErrors.windowOverlap({
            employeeId: conflict.employeeId,
            date: conflict.date,
            conflictingShiftId: conflict.conflictingShiftId,
          }),
        )
      : ok(undefined);
  }
}
