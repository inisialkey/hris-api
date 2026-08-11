/**
 * Month arithmetic on the ISO string, never through `Date`.
 *
 * These are calendar dates in a branch timezone: parsing one into a UTC instant
 * to add a month is how a boundary date moves by one in the wrong hemisphere
 * (organization's `dayAfter` carries the same note for the same reason).
 */

/** `2026-05-14` → `2026-05`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** `2026-05` → `2026-05-01`. */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** `2026-12` → `2027-01`. */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** Every month touched by `[from, to)`, ascending. `to` exclusive, so an empty range yields none. */
export function monthsBetween(from: string, to: string): string[] {
  if (from >= to) return [];
  const last = monthOf(previousDay(to));
  const months: string[] = [];
  for (let month = monthOf(from); month <= last; month = nextMonth(month)) months.push(month);
  return months;
}

/** `2026-05-31` → `2026-06-01`. The exclusive end of a one-day range. */
export function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function previousDay(date: string): string {
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}
