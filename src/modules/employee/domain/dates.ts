/**
 * Business dates are `YYYY-MM-DD` end to end (coding-standards-nestjs §6) —
 * never midnight timestamps, because a timezone conversion on one manufactures
 * off-by-one-day bugs in a module whose whole job is dates.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, days: number): string {
  if (!ISO_DAY.test(date)) throw new Error(`not a business date: ${date}`);
  // `Date.UTC` and not the local constructor: the arithmetic must not care what
  // timezone the pod is in.
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

export function toBusinessDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
