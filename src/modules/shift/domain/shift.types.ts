import type { HolidayKind } from '../../holiday';

/** Row shapes the module passes around, independent of Drizzle's inferred types. */

export interface ShiftRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  /** Branch-local wall clock, `HH:mm:ss` as PostgreSQL stores it (BR-SHF-008). */
  startTime: string;
  endTime: string;
  breakMinutes: number;
  breakStartTime: string | null;
  lateToleranceMinutes: number;
  earlyLeaveToleranceMinutes: number;
  punchInBeforeMinutes: number;
  punchOutAfterMinutes: number;
  color: string | null;
}

export interface PatternRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  cycleLength: number;
  observesHolidays: boolean;
}

export interface PatternDayRow {
  dayIndex: number;
  /** `null` = an OFF entry in the cycle. */
  shiftId: string | null;
}

export interface PatternWithDays extends PatternRow {
  days: PatternDayRow[];
}

export interface AssignmentRow {
  id: string;
  companyId: string;
  /** `null` = the company default arrangement (BR-SHF-002). */
  employeeId: string | null;
  patternId: string;
  cycleAnchorDate: string;
  note: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface RosterDayRow {
  id: string;
  employeeId: string;
  date: string;
  /** `null` = an explicit day off. */
  shiftId: string | null;
  worksOnHoliday: boolean;
  note: string | null;
}

/* ------------------------------------------------------------------------- *
 * §4.2's consumer contract.
 * ------------------------------------------------------------------------- */

export interface ScheduledShift {
  id: string;
  code: string;
  name: string;
  /** UTC instants (BR-SHF-008). */
  startAt: string;
  endAt: string;
  /** Punch window, UTC (BR-SHF-005) — it may span three calendar dates. */
  windowFrom: string;
  windowTo: string;
  breakMinutes: number;
  paidMinutes: number;
  lateToleranceMinutes: number;
  earlyLeaveToleranceMinutes: number;
}

export interface ScheduledDay {
  /** `YYYY-MM-DD`, branch-local calendar date. */
  date: string;
  kind: 'work' | 'off';
  source: 'explicit' | 'pattern' | 'default' | 'none';
  offReason?: 'day_off' | 'holiday' | 'unscheduled' | 'unplaced';
  /**
   * Paid minutes this arrangement schedules for this date **before** holiday
   * suppression; `0` is a real day off (§4.3, overtime.md BR-OVT-010).
   */
  standardMinutes: number;
  shift?: ScheduledShift;
  /** Present whenever a holiday lands on the date, worked or not. */
  holiday?: { kind: HolidayKind; name: string };
}

/** §7's grid cell — a `ScheduledDay` plus what the editor needs to act on it. */
export interface GridDay extends ScheduledDay {
  rosterDayId?: string;
  patternCode?: string;
}

/** Offset pagination, api-standards §5. */
export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

/** BR-SHF-011's blocker counts, the shape `SHF_IN_USE` carries in `details`. */
export interface ArchiveBlocker {
  type: string;
  count: number;
}
