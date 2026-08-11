import type { holidayKind } from '../../../database/schema/holiday.schema';

/** Derived from the pg enum, never re-typed (coding-standards-nestjs §1). */
export type HolidayKind = (typeof holidayKind.enumValues)[number];

/**
 * The scope a question is asked in. `companyId: null` is the tenant-wide reader —
 * an admin resolving before picking a company — and a branch never appears
 * without its company (BR-HOL-005).
 */
export interface HolidayScope {
  companyId: string | null;
  branchId: string | null;
}

/** One stored row, as everything above the repository sees it. */
export interface HolidayRow {
  id: string;
  companyId: string | null;
  branchId: string | null;
  date: string;
  name: string;
  kind: HolidayKind;
  observed: boolean;
  createdBy: string | null;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** §4.2's verdict for one date. */
export interface DayType {
  working: boolean;
  holiday?: { kind: HolidayKind; name: string };
}

export interface NonWorkingDay {
  date: string;
  kind: HolidayKind;
  name: string;
}

/**
 * §7's `/resolved` row. A negated day is **listed**, carrying the scope that
 * negated it, because the admin calendar renders it struck-through rather than
 * absent — a day that silently disappears is a day nobody can un-negate.
 */
export interface ResolvedDay {
  date: string;
  name: string;
  kind: HolidayKind;
  negatedAtScope: null | 'company' | 'branch';
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
