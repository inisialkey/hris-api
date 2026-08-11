/**
 * BR-SHF-002's ladder, BR-SHF-003's cycle math, BR-SHF-004's suppression and
 * §4.3's instants — one pure function over rows plus a calendar.
 *
 * **Configuration only, resolved on read** (§1, grilled 2026-08-02). Nothing is
 * materialized: no generation cron, no horizon, no regeneration-versus-hand-edit
 * conflict, and no row for a day nobody thought about. The trade is BR-SHF-010 —
 * editing a pattern changes what past *unlocked* dates resolve to, and the record
 * of what an employee was actually scheduled for is attendance's derived day.
 */

import type { HolidayKind } from '../../holiday';
import type { PatternDayRow, ScheduledDay, ShiftRow } from './shift.types';
import { instantsFor, paidMinutes } from './time';
import { daysBetween } from './time';

/** The arrangement in force on the date — an employee's, or the company default. */
export interface Arrangement {
  source: 'pattern' | 'default';
  patternId: string;
  patternCode: string;
  cycleLength: number;
  observesHolidays: boolean;
  cycleAnchorDate: string;
  days: readonly PatternDayRow[];
}

export interface ExplicitDay {
  rosterDayId: string;
  shiftId: string | null;
  worksOnHoliday: boolean;
}

export interface ResolutionInput {
  date: string;
  /** `null` = the org anomaly BR-SHF-008 refuses to guess a timezone for. */
  placement: { branchId: string; timezone: string } | null;
  explicit?: ExplicitDay;
  arrangement?: Arrangement;
  /** Present only when a holiday makes the date non-working for this scope. */
  holiday?: { kind: HolidayKind; name: string };
  shiftsById: ReadonlyMap<string, ShiftRow>;
}

/**
 * BR-SHF-003 — `floor(date − anchor) mod cycleLength`, with a modulo that stays
 * positive. A date **before** the anchor is legal and resolves by counting
 * backwards through the cycle; JavaScript's `%` would return a negative index and
 * silently miss every entry.
 */
export function dayIndexFor(
  arrangement: Pick<Arrangement, 'cycleAnchorDate' | 'cycleLength'>,
  date: string,
): number {
  const elapsed = daysBetween(arrangement.cycleAnchorDate, date);
  return ((elapsed % arrangement.cycleLength) + arrangement.cycleLength) % arrangement.cycleLength;
}

/** The shift a pattern schedules for a date, or `null` for an OFF entry. */
export function patternShiftId(arrangement: Arrangement, date: string): string | null {
  const index = dayIndexFor(arrangement, date);
  return arrangement.days.find((day) => day.dayIndex === index)?.shiftId ?? null;
}

/** UC-SHF-001, the whole ladder in one place. */
export function resolveScheduledDay(input: ResolutionInput): ScheduledDay {
  const { date } = input;
  const ladder = walkLadder(input);
  const shift = ladder.shiftId ? input.shiftsById.get(ladder.shiftId) : undefined;

  // §4.3: the paid minutes of the shift the ladder produced, **before**
  // suppression — which is what overtime.md BR-OVT-010's rest-day boundary is
  // defined against, and why a suppressed holiday still reports what that
  // weekday normally schedules.
  const standardMinutes = shift ? paidMinutes(shift) : 0;
  const holiday = input.holiday ? { ...input.holiday } : undefined;

  // BR-SHF-004. The **arrangement** decides whether holidays are observed, even
  // on an explicit cell; the explicit row's escape hatch is `works_on_holiday`.
  // With no arrangement in force the default is to observe.
  const observes = input.arrangement?.observesHolidays ?? true;
  if (input.holiday && observes && !input.explicit?.worksOnHoliday) {
    return {
      date,
      kind: 'off',
      source: ladder.source,
      offReason: 'holiday',
      standardMinutes,
      holiday,
    };
  }

  if (!shift) {
    return {
      date,
      kind: 'off',
      source: ladder.source,
      offReason: ladder.source === 'none' ? 'unscheduled' : 'day_off',
      standardMinutes: 0,
      ...(holiday ? { holiday } : {}),
    };
  }

  // BR-SHF-008: no placement, no timezone, and this module refuses to guess one.
  // `standardMinutes` is 0 here rather than the shift's — §4.3 lists the unplaced
  // employee beside the pattern OFF entry, not beside the suppressed holiday.
  if (!input.placement) {
    return {
      date,
      kind: 'off',
      source: ladder.source,
      offReason: 'unplaced',
      standardMinutes: 0,
      ...(holiday ? { holiday } : {}),
    };
  }

  const instants = instantsFor(date, shift, input.placement.timezone);
  return {
    date,
    kind: 'work',
    source: ladder.source,
    standardMinutes,
    shift: {
      id: shift.id,
      code: shift.code,
      name: shift.name,
      startAt: instants.startAt,
      endAt: instants.endAt,
      windowFrom: instants.windowFrom,
      windowTo: instants.windowTo,
      breakMinutes: shift.breakMinutes,
      paidMinutes: standardMinutes,
      lateToleranceMinutes: shift.lateToleranceMinutes,
      earlyLeaveToleranceMinutes: shift.earlyLeaveToleranceMinutes,
    },
    ...(holiday ? { holiday } : {}),
  };
}

/** BR-SHF-002: explicit row > employee assignment > company default > nothing. */
function walkLadder(input: ResolutionInput): {
  shiftId: string | null;
  source: ScheduledDay['source'];
} {
  if (input.explicit) return { shiftId: input.explicit.shiftId, source: 'explicit' };
  if (input.arrangement) {
    return {
      shiftId: patternShiftId(input.arrangement, input.date),
      source: input.arrangement.source,
    };
  }
  return { shiftId: null, source: 'none' };
}
