/**
 * BR-HOL-002, the whole of it: **most-specific-wins per `(date, kind)`**, branch
 * over company over tenant-wide, and a date is non-working when a winning row is
 * `observed`.
 *
 * Pure, and deliberately so. holiday.md §4.2 says this reducer is implemented
 * twice — here and in shared Dart over the device's mirror (BR-HOL-010) — and
 * ADR-0018 decision 7 puts the vectors both implementations run in the handbook
 * for exactly that reason. Nothing in this file reads a database, a clock or a
 * request context, so the two implementations can disagree only about the rule.
 *
 * **Per kind, not per date.** A national holiday and a company event landing on
 * one date are two independent questions, and negating one of them says nothing
 * about the other (§9: *"consumers care only about `working=false`, so
 * double-marking is harmless"*).
 */

import type {
  DayType,
  HolidayKind,
  HolidayScope,
  NonWorkingDay,
  ResolvedDay,
} from './holiday.types';

/** The subset of a row resolution reads — the device mirror carries no more. */
export interface ResolvableRow {
  companyId: string | null;
  branchId: string | null;
  date: string;
  name: string;
  kind: HolidayKind;
  observed: boolean;
}

/** BR-HOL-002's display order when several kinds land on one date. */
const DISPLAY_PRIORITY: readonly HolidayKind[] = ['national', 'cuti_bersama', 'custom'];

const TENANT = 0;
const COMPANY = 1;
const BRANCH = 2;

/**
 * How specifically this row addresses the scope, or `null` when it addresses a
 * different one. Repositories already filter to the chain; this is what keeps the
 * reducer honest when it is handed a month of rows for a whole tenant, which is
 * exactly what the cache holds.
 */
function specificity(row: ResolvableRow, scope: HolidayScope): number | null {
  if (row.companyId === null) return TENANT;
  if (row.companyId !== scope.companyId) return null;
  if (row.branchId === null) return COMPANY;
  return row.branchId === scope.branchId ? BRANCH : null;
}

interface Winner {
  row: ResolvableRow;
  level: number;
}

/**
 * The winning row per kind for one date. Exported because three different
 * answers are built from it and re-deriving it in each is how two of them end up
 * disagreeing.
 */
export function winners(
  rows: readonly ResolvableRow[],
  scope: HolidayScope,
  date: string,
): Map<HolidayKind, Winner> {
  const byKind = new Map<HolidayKind, Winner>();
  for (const row of rows) {
    if (row.date !== date) continue;
    const level = specificity(row, scope);
    if (level === null) continue;
    const current = byKind.get(row.kind);
    if (!current || level > current.level) byKind.set(row.kind, { row, level });
  }
  return byKind;
}

/** UC-HOL-001's verdict. No rows, or every winner negated, means an ordinary working day. */
export function resolveDate(
  rows: readonly ResolvableRow[],
  scope: HolidayScope,
  date: string,
): DayType {
  const observed = [...winners(rows, scope, date).values()]
    .filter((winner) => winner.row.observed)
    .map((winner) => winner.row);
  const leading = byDisplayPriority(observed)[0];
  return leading
    ? { working: false, holiday: { kind: leading.kind, name: leading.name } }
    : { working: true };
}

/**
 * `nonWorkingDays` over `[from, to)` — one entry per non-working *kind*, which is
 * what a caller counting distinct non-working dates has to collapse itself. Dates
 * with no rows never appear: a date nobody marked is a working day, and
 * enumerating the calendar to say so would make the answer proportional to the
 * range rather than to the holidays in it.
 */
export function resolveRange(
  rows: readonly ResolvableRow[],
  scope: HolidayScope,
  from: string,
  to: string,
): NonWorkingDay[] {
  const dates = [
    ...new Set(rows.filter((row) => row.date >= from && row.date < to).map((r) => r.date)),
  ].sort();
  const days: NonWorkingDay[] = [];
  for (const date of dates) {
    for (const winner of byDisplayPriority(
      [...winners(rows, scope, date).values()].filter((w) => w.row.observed).map((w) => w.row),
    )) {
      days.push({ date, kind: winner.kind, name: winner.name });
    }
  }
  return days;
}

/**
 * §7's `/resolved` view: every `(date, kind)` the scope can see, negations
 * included and marked with the scope that negated them.
 *
 * The name on a negated entry comes from the **negated** row rather than from the
 * negation, because BR-HOL-004 guarantees the broader row exists and "Idul Fitri
 * — working day here" is the sentence the admin calendar has to render. A
 * negation whose target was later deleted (§9's orphan) keeps its own name.
 */
export function resolvedCalendar(
  rows: readonly ResolvableRow[],
  scope: HolidayScope,
): ResolvedDay[] {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const days: ResolvedDay[] = [];
  for (const date of dates) {
    const perKind = winners(rows, scope, date);
    for (const kind of DISPLAY_PRIORITY) {
      const winner = perKind.get(kind);
      if (!winner) continue;
      days.push({
        date,
        kind,
        name: winner.row.observed ? winner.row.name : negatedName(rows, scope, date, kind, winner),
        negatedAtScope: winner.row.observed ? null : winner.level === BRANCH ? 'branch' : 'company',
      });
    }
  }
  return days;
}

/**
 * BR-HOL-004 — does a **strictly broader** observed row exist for this
 * `(date, kind)`? Negating nothing is a configuration error, and the check is
 * here rather than in the service because "broader" is the same specificity
 * ladder resolution walks, and two ladders would eventually disagree.
 */
export function hasBroaderObserved(
  rows: readonly ResolvableRow[],
  target: Pick<ResolvableRow, 'companyId' | 'branchId' | 'date' | 'kind'>,
): boolean {
  const scope = { companyId: target.companyId, branchId: target.branchId };
  const own = specificity({ ...target, name: '', observed: false }, scope);
  if (own === null) return false;
  return rows.some((row) => {
    if (row.date !== target.date || row.kind !== target.kind || !row.observed) return false;
    const level = specificity(row, scope);
    return level !== null && level < own;
  });
}

/** The most specific observed row beneath the negation — the day being cancelled. */
function negatedName(
  rows: readonly ResolvableRow[],
  scope: HolidayScope,
  date: string,
  kind: HolidayKind,
  negation: Winner,
): string {
  let best: Winner | null = null;
  for (const row of rows) {
    if (row.date !== date || row.kind !== kind || !row.observed) continue;
    const level = specificity(row, scope);
    if (level === null || level >= negation.level) continue;
    if (!best || level > best.level) best = { row, level };
  }
  return (best ?? negation).row.name;
}

function byDisplayPriority(rows: readonly ResolvableRow[]): ResolvableRow[] {
  return [...rows].sort(
    (a, b) => DISPLAY_PRIORITY.indexOf(a.kind) - DISPLAY_PRIORITY.indexOf(b.kind),
  );
}
