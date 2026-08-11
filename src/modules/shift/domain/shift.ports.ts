import type {
  ArchiveBlocker,
  AssignmentRow,
  Page,
  Paged,
  PatternRow,
  PatternWithDays,
  RosterDayRow,
  ScheduledDay,
  ShiftRow,
} from './shift.types';

/* ------------------------------------------------------------------------- *
 * The consumer contract — shift.md §4.2, verbatim.
 * ------------------------------------------------------------------------- */

export const SHIFT_QUERY_PORT = Symbol('SHIFT_QUERY_PORT');

export interface ShiftQueryPort {
  /** One employee, one date — the attendance hot path. */
  scheduleFor(employeeId: string, date: string): Promise<ScheduledDay>;
  /** `[from, to)` — mobile window, leave working-day counting, overtime baselines. */
  scheduleRange(employeeId: string, from: string, to: string): Promise<ScheduledDay[]>;
  /** Batch for grids and per-day derivation runs. One query, keyed result. */
  scheduleForMany(employeeIds: string[], date: string): Promise<Map<string, ScheduledDay>>;
}

/* ------------------------------------------------------------------------- *
 * Internal ports — this module's own seams.
 * ------------------------------------------------------------------------- */

export const SHIFT_REPOSITORY = Symbol('SHIFT_REPOSITORY');

export type NewShift = Omit<ShiftRow, 'id'>;

export interface ShiftRepositoryPort {
  list(filter: { companyId: string; q?: string }, page: Page): Promise<Paged<ShiftRow>>;
  findById(id: string): Promise<ShiftRow | null>;
  findByCode(companyId: string, code: string): Promise<ShiftRow | null>;
  findManyByIds(ids: string[]): Promise<Map<string, ShiftRow>>;
  /** Every live shift of a company — the resolver's lookup table for a grid page. */
  findAllByCompany(companyId: string): Promise<Map<string, ShiftRow>>;
  create(values: NewShift): Promise<ShiftRow>;
  update(
    id: string,
    patch: Partial<Omit<ShiftRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<ShiftRow | null>;
  archive(id: string): Promise<boolean>;
  /** BR-SHF-011: live pattern entries + live/future roster days, counted. */
  archiveBlockers(id: string, today: string): Promise<ArchiveBlocker[]>;
  /** §7's `usageCount` — the archive-guard preview, over the next 30 days. */
  usageCounts(ids: string[], today: string, horizon: string): Promise<Map<string, number>>;
}

export const PATTERN_REPOSITORY = Symbol('PATTERN_REPOSITORY');

export interface PatternRepositoryPort {
  list(filter: { companyId: string; q?: string }, page: Page): Promise<Paged<PatternWithDays>>;
  findById(id: string): Promise<PatternWithDays | null>;
  findByCode(companyId: string, code: string): Promise<PatternRow | null>;
  findManyByIds(ids: string[]): Promise<Map<string, PatternWithDays>>;
  /** Live patterns with an entry referencing this shift — UC-SHF-002's re-check. */
  usingShift(shiftId: string): Promise<PatternWithDays[]>;
  /** UC-SHF-003: the pattern and its cycle in one transaction, days replaced wholesale. */
  create(
    values: Omit<PatternRow, 'id'>,
    days: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays>;
  update(
    id: string,
    patch: Partial<Pick<PatternRow, 'name' | 'observesHolidays' | 'cycleLength'>>,
    days?: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays | null>;
  archive(id: string): Promise<boolean>;
  /** BR-SHF-011: live or future assignments, counted. */
  archiveBlockers(id: string, today: string): Promise<ArchiveBlocker[]>;
  assignedEmployeeCounts(ids: string[], today: string): Promise<Map<string, number>>;
}

export const ASSIGNMENT_REPOSITORY = Symbol('ROSTER_ASSIGNMENT_REPOSITORY');

export interface AssignmentRepositoryPort {
  /** The live rows for one employee — the planner's input and the exclusion's domain. */
  liveHistory(employeeId: string): Promise<AssignmentRow[]>;
  /** Newest first, scheduled future rows included (§7). */
  history(employeeId: string): Promise<AssignmentRow[]>;
  companyDefaultHistory(companyId: string): Promise<AssignmentRow[]>;
  findById(id: string): Promise<AssignmentRow | null>;
  /** In force on a date: the employee's own row, else `null`. */
  liveOn(employeeId: string, date: string): Promise<AssignmentRow | null>;
  /** Batch form for the grid — one query, keyed by employee. */
  liveOnForMany(employeeIds: string[], date: string): Promise<Map<string, AssignmentRow>>;
  /** Every row of an employee overlapping `[from, to)`, for a range read. */
  overlapping(employeeId: string, from: string, to: string): Promise<AssignmentRow[]>;
  /** The company default in force on a date (`employee_id IS NULL`). */
  defaultOn(companyId: string, date: string): Promise<AssignmentRow | null>;
  defaultsOverlapping(companyId: string, from: string, to: string): Promise<AssignmentRow[]>;
  /** BR-SHF-007's supersede: close the predecessor, insert the successor, one transaction. */
  supersede(plan: {
    close: { id: string; effectiveTo: string } | null;
    insert: Omit<AssignmentRow, 'id'>;
  }): Promise<AssignmentRow>;
  /** `DELETE /{id}`: future rows only — soft delete, then reopen the predecessor. */
  cancel(plan: {
    softDelete: string;
    reopen: { id: string; effectiveTo: string | null } | null;
  }): Promise<void>;
}

export const ROSTER_DAY_REPOSITORY = Symbol('ROSTER_DAY_REPOSITORY');

export interface RosterDayRepositoryPort {
  findFor(employeeId: string, date: string): Promise<RosterDayRow | null>;
  findById(id: string): Promise<RosterDayRow | null>;
  /** `[from, to)` for one employee — the range read and the neighbour lookups. */
  findRange(employeeId: string, from: string, to: string): Promise<RosterDayRow[]>;
  /** The grid: many employees, one range, one query. */
  findRangeForMany(employeeIds: string[], from: string, to: string): Promise<RosterDayRow[]>;
  /** UC-SHF-005: upsert on `(employee_id, date)`, the natural key §7 batches by. */
  upsert(values: Omit<RosterDayRow, 'id'>): Promise<RosterDayRow>;
  softDelete(id: string): Promise<RosterDayRow | null>;
  /** Live or future rows referencing a shift — BR-SHF-011's blocker half. */
  countByShift(shiftId: string, from: string): Promise<number>;
  /**
   * Every live row referencing a shift. UC-SHF-002 needs two different slices of
   * it — the **future** rows to re-check for window overlap, and **every** date
   * for BR-SHF-009's lock check, since a definition edit re-interprets whatever
   * dates it is scheduled on.
   */
  usage(shiftId: string): Promise<{ employeeId: string; date: string }[]>;
  /**
   * UC-SHF-009's review list: explicit rows on these dates carrying
   * `works_on_holiday`. They **stand** after a calendar change (BR-SHF-004), so
   * the grid has to surface the deliberate holiday work the edit just implied.
   */
  flaggedOn(dates: readonly string[]): Promise<RosterDayRow[]>;
}

export const EMPLOYEE_LOOKUP = Symbol('SHIFT_EMPLOYEE_LOOKUP');

export interface EmployeeSummary {
  employeeId: string;
  employeeNumber: string;
  fullName: string;
  companyId: string;
  status: string;
  /** §7: an assignment may not start before the employment it schedules. */
  joinDate: string;
  /** `null` when the person holds no login — there is nobody to notify. */
  userId: string | null;
}

/**
 * The identity reads this module makes, all through **`employee_directory`** —
 * ADR-0001 rule 6's published view, which exists precisely so a grid can filter
 * and sort on a name before the page boundary (rule 6's own amendment).
 */
export interface EmployeeLookupPort {
  find(employeeId: string): Promise<EmployeeSummary | null>;
  findByUserId(userId: string): Promise<EmployeeSummary | null>;
  findByNumber(employeeNumber: string): Promise<EmployeeSummary | null>;
  findMany(employeeIds: string[]): Promise<Map<string, EmployeeSummary>>;
  /** §7's grid page — paging is over employees, every page carrying the full range. */
  page(
    filter: { companyId: string; employeeId?: string; q?: string; includeTerminal?: boolean },
    page: Page,
  ): Promise<Paged<EmployeeSummary>>;
}

export const SCHEDULE_CACHE = Symbol('SCHEDULE_CACHE');

/**
 * §4.2's verdict cache: `hris:shift:{tenantId}:schedule:{employeeId}:{yyyy-mm}`,
 * TTL 15 minutes, month buckets because attendance derivation walks a period
 * rather than a date.
 */
export interface ScheduleCachePort {
  read(tenantId: string, employeeId: string, month: string): Promise<ScheduledDay[] | null>;
  write(
    tenantId: string,
    employeeId: string,
    month: string,
    days: readonly ScheduledDay[],
  ): Promise<void>;
  bustEmployee(tenantId: string, employeeId: string): Promise<void>;
  bustEmployees(tenantId: string, employeeIds: readonly string[]): Promise<void>;
  /** `shift.definition.changed` is deliberately coarse — the affected set is unbounded. */
  bustTenant(tenantId: string): Promise<void>;
}

export const SHIFT_OUTBOX = Symbol('SHIFT_OUTBOX');

/** §12's two events, named rather than typed loose (coding-standards-nestjs §7). */
export interface ShiftOutboxPort {
  emit(event: {
    name: 'shift.roster.changed' | 'shift.definition.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
