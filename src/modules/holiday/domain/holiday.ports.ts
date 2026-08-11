import type {
  DayType,
  HolidayKind,
  HolidayRow,
  HolidayScope,
  NonWorkingDay,
  Page,
  Paged,
} from './holiday.types';
import type { ResolvableRow } from './resolve';

/* ------------------------------------------------------------------------- *
 * The consumer contract — holiday.md §4.2, verbatim.
 * ------------------------------------------------------------------------- */

export const HOLIDAY_QUERY_PORT = Symbol('HOLIDAY_QUERY_PORT');

export interface HolidayQueryPort {
  /** Winning verdict for one date in one scope (BR-HOL-002). */
  dayType(companyId: string, branchId: string | null, date: string): Promise<DayType>;
  /** All non-working dates in `[from, to)` for a scope — leave net-day math, shift planning. */
  nonWorkingDays(
    companyId: string,
    branchId: string | null,
    from: string,
    to: string,
  ): Promise<NonWorkingDay[]>;
}

/* ------------------------------------------------------------------------- *
 * Internal ports — this module's own seams.
 * ------------------------------------------------------------------------- */

export const HOLIDAY_REPOSITORY = Symbol('HOLIDAY_REPOSITORY');

export interface HolidayListFilter {
  year: number;
  /** `null` = tenant-wide assignment: no company predicate at all (data-scope §1). */
  companyIds: string[] | null;
  companyId?: string;
  branchId?: string;
  kind?: HolidayKind;
}

export interface NewHoliday {
  companyId: string | null;
  branchId: string | null;
  date: string;
  name: string;
  kind: HolidayKind;
  observed: boolean;
}

/**
 * api-standards §8's keyset position, opaque to the client — and it carries the
 * **row id only**, deliberately.
 *
 * `updated_at` is `timestamptz`, which PostgreSQL keeps to the microsecond and
 * `node-pg` hands over as a millisecond `Date`. A cursor built from that value is
 * therefore *earlier* than the row it names, so `WHERE updated_at > cursor`
 * matches that row again and the page repeats forever. Naming the row and
 * comparing against its stored value inside the query removes the round trip
 * through JavaScript, which is where the precision was being lost.
 */
export interface SyncCursor {
  id: string;
}

export interface HolidayRepositoryPort {
  list(filter: HolidayListFilter, page: Page): Promise<Paged<HolidayRow>>;
  findById(id: string): Promise<HolidayRow | null>;
  /**
   * Every live row of the tenant inside `[from, to)`, **all scopes**. The
   * reducer is what narrows to a scope chain (BR-HOL-002), which is what lets one
   * cached month answer for every company and branch in the tenant rather than
   * one entry per reader.
   */
  inRange(from: string, to: string): Promise<HolidayRow[]>;
  create(values: NewHoliday): Promise<HolidayRow>;
  update(
    id: string,
    patch: Partial<Pick<HolidayRow, 'name' | 'date' | 'observed'>>,
  ): Promise<HolidayRow | null>;
  softDelete(id: string): Promise<HolidayRow | null>;
  /** Delta sync, api-standards §8: `(updated_at, id)` ascending, tombstones included. */
  changedSince(
    scope: HolidayScope,
    updatedSince: Date | null,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<HolidayRow[]>;
}

export const EMPLOYEE_SCOPE = Symbol('EMPLOYEE_SCOPE');

/**
 * The caller's own employment, for §7's self-scoped reads. Backed by the
 * `employee_directory` view (ADR-0001 rule 6) rather than by a port employee.md
 * does not serve — the view is the channel that exists for identity columns a
 * consumer needs without reaching the table.
 */
export interface EmployeeScopePort {
  findByUserId(userId: string): Promise<{ employeeId: string; companyId: string } | null>;
}

export const HOLIDAY_CACHE = Symbol('HOLIDAY_CACHE');

/**
 * UC-HOL-001's resolution cache, keyed by **month** rather than by
 * `(company, branch, date)`.
 *
 * The document says "cached per (tenant, company, branch, date)"; the shape here
 * is one key per tenant-month holding the rows the reducer takes, and it is the
 * same cache with the scope factored out. Two reasons, both about the bust: a
 * calendar change knows its dates and cannot know who will read them, so
 * scope-keyed entries would have to be found by scanning; and a year of rows for
 * one tenant is a few dozen small objects, so per-scope copies would multiply by
 * every branch for no fewer database reads.
 */
export interface HolidayCachePort {
  read(tenantId: string, month: string): Promise<ResolvableRow[] | null>;
  write(tenantId: string, month: string, rows: readonly ResolvableRow[]): Promise<void>;
  bust(tenantId: string, months: readonly string[]): Promise<void>;
}

export const HOLIDAY_OUTBOX = Symbol('HOLIDAY_OUTBOX');

/** §12's single event, named rather than typed loose (coding-standards-nestjs §7). */
export interface HolidayOutboxPort {
  emit(event: {
    name: 'holiday.calendar.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
