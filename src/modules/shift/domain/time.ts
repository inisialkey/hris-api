/**
 * §4.3's arithmetic, and the one place a branch-local wall clock becomes a UTC
 * instant.
 *
 * Everything here is pure and takes its date from its caller: there is no `now`,
 * which is what `coding-standards-nestjs.md` §6 bans from domain code and also
 * what makes the golden vectors of §14 possible.
 */

import type { ShiftRow } from './shift.types';

export const MINUTES_PER_DAY = 1440;

/** The columns the arithmetic actually needs — a pattern entry, a roster cell, a form. */
export type ShiftTimes = Pick<
  ShiftRow,
  'startTime' | 'endTime' | 'breakMinutes' | 'punchInBeforeMinutes' | 'punchOutAfterMinutes'
>;

/** `HH:mm` or `HH:mm:ss` → minutes past midnight. */
export function minutesOfDay(wallTime: string): number {
  const [hours, minutes] = wallTime.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * `(end − start + 1440) mod 1440` — never 0, because BR-SHF-001's CHECK refuses
 * `end_time = start_time`, and a shift whose end is *before* its start crosses
 * midnight rather than being invalid.
 */
export function spanMinutes(shift: Pick<ShiftTimes, 'startTime' | 'endTime'>): number {
  const span = minutesOfDay(shift.endTime) - minutesOfDay(shift.startTime);
  return ((span % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** `spanMinutes − break_minutes`. The break is unpaid and fixed (§1's exclusion). */
export function paidMinutes(shift: Pick<ShiftTimes, 'startTime' | 'endTime' | 'breakMinutes'>) {
  return spanMinutes(shift) - shift.breakMinutes;
}

export function crossesMidnight(shift: Pick<ShiftTimes, 'startTime' | 'endTime'>): boolean {
  return minutesOfDay(shift.endTime) < minutesOfDay(shift.startTime);
}

/**
 * The punch window as **minutes relative to midnight of the shift's own date**.
 * Both ends may fall outside `[0, 1440)`: a night shift's window starts on the
 * previous evening and ends after the following midnight, which is the whole
 * reason BR-SHF-005 fixes the working day as the start date.
 */
export function windowMinutes(shift: ShiftTimes): { from: number; to: number } {
  const start = minutesOfDay(shift.startTime);
  return {
    from: start - shift.punchInBeforeMinutes,
    to: start + spanMinutes(shift) + shift.punchOutAfterMinutes,
  };
}

export interface Instants {
  startAt: string;
  endAt: string;
  windowFrom: string;
  windowTo: string;
}

/** §4.3's four instants for one roster date, in the branch's timezone. */
export function instantsFor(date: string, shift: ShiftTimes, timeZone: string): Instants {
  const startAt = zonedWallTimeToUtc(date, shift.startTime, timeZone);
  const window = windowMinutes(shift);
  const midnight = startAt.getTime() - minutesOfDay(shift.startTime) * 60_000;

  return {
    startAt: startAt.toISOString(),
    endAt: addMinutes(startAt, spanMinutes(shift)).toISOString(),
    windowFrom: new Date(midnight + window.from * 60_000).toISOString(),
    windowTo: new Date(midnight + window.to * 60_000).toISOString(),
  };
}

/**
 * A wall-clock time in a named zone → the UTC instant it names.
 *
 * One probe is enough **here** and would not be in general: the conversion
 * formats a guessed instant in the target zone and subtracts the difference,
 * which is exact for a zone whose offset does not change, and Indonesia observes
 * no DST (BR-SHF-008 — *"no local time is ambiguous or skipped"*). §15's
 * international-timezone item is where the second probe would be needed.
 *
 * `Intl` rather than a table of the three Indonesian offsets: the table would be
 * a second copy of organization's own timezone CHECK, and copies drift.
 */
export function zonedWallTimeToUtc(date: string, wallTime: string, timeZone: string): Date {
  const [hours, minutes] = wallTime.split(':');
  const asIfUtc = Date.parse(
    `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`,
  );
  return new Date(asIfUtc - offsetMinutes(timeZone, asIfUtc) * 60_000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** How far ahead of UTC the zone is at that instant, in minutes. */
function offsetMinutes(timeZone: string, instant: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const local = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'));
  return (local - instant) / 60_000;
}

function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/* ------------------------------------------------------------------------- *
 * Calendar-date arithmetic — on the ISO string, never through a local `Date`.
 * ------------------------------------------------------------------------- */

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every date in `[from, to)`, ascending. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date < to; date = addDays(date, 1)) dates.push(date);
  return dates;
}
