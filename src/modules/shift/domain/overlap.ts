/**
 * BR-SHF-006 — **punch windows may not overlap for one employee**, checked where
 * the roster is edited rather than where a punch arrives.
 *
 * Unambiguous punch→shift matching is a property of the roster: attendance
 * matches a punch to the shift whose window contains it (BR-SHF-005), and two
 * windows containing one instant leaves it with two answers and no rule to pick
 * between them. §9's 24-hour-coverage case is the shape this catches — a night
 * shift ending 06:00 with a 60-minute out-window against a morning shift starting
 * 06:00 with a 60-minute in-window overlap by two hours, and the tenant shrinks
 * the windows, which is what they are for.
 */

import { MINUTES_PER_DAY, windowMinutes, type ShiftTimes } from './time';

export interface OverlapCandidate {
  shiftId: string;
  times: ShiftTimes;
}

/**
 * Do `earlier`'s window (on its own date) and `later`'s window (`dayGap` days
 * afterwards) intersect? Both windows are expressed as minutes from midnight of
 * `earlier`'s date, which is what makes a three-date night-shift window a plain
 * comparison.
 */
export function windowsOverlap(earlier: ShiftTimes, later: ShiftTimes, dayGap = 1): boolean {
  const first = windowMinutes(earlier);
  const second = windowMinutes(later);
  const offset = dayGap * MINUTES_PER_DAY;
  return first.to > second.from + offset;
}

export interface CycleConflict {
  dayIndex: number;
  shiftId: string;
  conflictingShiftId: string;
}

/**
 * UC-SHF-003's static check: every consecutive pair of a pattern's entries,
 * **including the wrap** from the last index to the first, because a cycle
 * repeats and the last day's evening meets the first day's morning every time it
 * does. A one-day cycle is checked against itself for the same reason.
 */
export function cycleConflicts(
  entries: readonly { dayIndex: number; shiftId: string | null }[],
  cycleLength: number,
  shifts: ReadonlyMap<string, ShiftTimes>,
): CycleConflict[] {
  const conflicts: CycleConflict[] = [];
  const byIndex = new Map(entries.map((entry) => [entry.dayIndex, entry.shiftId]));

  for (let index = 0; index < cycleLength; index += 1) {
    const currentId = byIndex.get(index);
    const nextId = byIndex.get((index + 1) % cycleLength);
    if (!currentId || !nextId) continue;

    const current = shifts.get(currentId);
    const next = shifts.get(nextId);
    if (!current || !next) continue;

    if (windowsOverlap(current, next)) {
      conflicts.push({ dayIndex: index, shiftId: currentId, conflictingShiftId: nextId });
    }
  }
  return conflicts;
}

export interface NeighbourConflict {
  date: string;
  shiftId: string;
  conflictingShiftId: string;
}

/**
 * The write-time check for a single date: the incoming shift against the shifts
 * resolved for the day before and the day after (§4.2's *"resolved neighbour
 * days"*). A roster-day write, an assignment switch-over and a shift-definition
 * edit all reduce to this.
 */
export function neighbourConflict(
  date: string,
  incoming: OverlapCandidate | null,
  previous: OverlapCandidate | null,
  next: OverlapCandidate | null,
): NeighbourConflict | null {
  if (!incoming) return null;

  if (previous && windowsOverlap(previous.times, incoming.times)) {
    return { date, shiftId: incoming.shiftId, conflictingShiftId: previous.shiftId };
  }
  if (next && windowsOverlap(incoming.times, next.times)) {
    return { date, shiftId: incoming.shiftId, conflictingShiftId: next.shiftId };
  }
  return null;
}
