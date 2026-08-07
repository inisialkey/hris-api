import type { Result } from '../../../shared/result';
import type {
  ContractRow,
  DirectoryRow,
  EmployeeCreateInput,
  EmployeeListRow,
  EmployeeRow,
  EmployeeStatus,
  EmployeeUpdateInput,
  FamilyMemberRow,
  StatusHistoryRow,
  StatusSource,
} from './employee.types';

/* ------------------------------------------------------------------------- *
 * The consumer contracts — employee.md §13.
 *
 * Two of the three ports §13 declares ship here. `EmployeePayrollPort` does not,
 * and the line is deliberate rather than budgetary: a port whose implementation
 * is a thin projection of machinery this module needs anyway can be written
 * correctly with no caller, while one that needs machinery only its caller can
 * shape cannot. `rosterFor` decrypts bank details, writes one sensitive-read row
 * per run rather than per employee, assembles placement from `OrgQueryPort` and
 * contract facts from a second table, and carries an `includeExited` mode whose
 * only definition of correct is "what a THR run needs". Payroll is the module
 * that can say. A-195.
 * ------------------------------------------------------------------------- */

export const EMPLOYEE_HIRE_PORT = Symbol('EMPLOYEE_HIRE_PORT');

export interface EmployeeHirePort {
  /**
   * Runs UC-EMP-001 unchanged — employees row, initial contract, `hire` status
   * history, `OrgPlacementPort.assignOnHire`, optional account — inside the
   * CALLER's transaction. One hire path, not two: the create form, the
   * `employee.master` import row handler, and recruitment's conversion all reach
   * the same use case, which is what stops the placement seed acquiring a second
   * caller with its own idea of what a hire is (BR-EMP-002).
   */
  hire(input: EmployeeCreateInput): Promise<Result<{ employeeId: string }>>;
}

export const EMPLOYEE_STATUS_PORT = Symbol('EMPLOYEE_STATUS_PORT');

export interface EmployeeStatusPort {
  /**
   * Schedules `active → on_leave` at `from` and `on_leave → active` at
   * `to + 1 day` as two `employee_status_history` rows with source `leave` and
   * `sourceId` = the request. The daily effectuate job applies them; same
   * transaction as the caller (leave.md BR-LVE-017).
   */
  scheduleLeaveStatus(
    employeeId: string,
    from: string,
    to: string,
    leaveRequestId: string,
  ): Promise<void>;
  /** Cancels unapplied rows for the request; reverses an already-applied one. */
  cancelLeaveStatus(leaveRequestId: string): Promise<void>;
}

/* ------------------------------------------------------------------------- *
 * Ports consumed.
 * ------------------------------------------------------------------------- */

// `AccountLifecyclePort` is **auth's** port, not this module's: the owner
// declares the token and the interface, and the consumer imports them from the
// owner's facade (ADR-0001 §1). Nothing to re-declare here.

/* ------------------------------------------------------------------------- *
 * Internal ports — the module's own seams, not a cross-module surface.
 * ------------------------------------------------------------------------- */

export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export interface EmployeeFilter {
  companyIds: string[] | null;
  companyId?: string;
  status?: EmployeeStatus;
  employmentType?: string;
  q?: string;
}

export const EMPLOYEE_REPOSITORY = Symbol('EMPLOYEE_REPOSITORY');

export interface EmployeeRepositoryPort {
  /** Never selects an encrypted column — see `EmployeeListRow`. */
  list(filter: EmployeeFilter, page: Page): Promise<Paged<EmployeeListRow>>;
  findById(id: string): Promise<EmployeeRow | null>;
  findByUserId(userId: string): Promise<EmployeeRow | null>;
  /**
   * BR-EMP-001/004's duplicate check, on the blind index and never on
   * ciphertext. Returns the colliding id so the caller can decide between a
   * duplicate error and a rehire hint; `excludeId` is the self-exclusion an
   * edit needs.
   */
  findLiveByNikBidx(nikBidx: string, excludeId?: string): Promise<{ id: string } | null>;
  findLiveByNpwpBidx(npwpBidx: string, excludeId?: string): Promise<{ id: string } | null>;
  create(input: EmployeeCreateInput, employeeNumber: string): Promise<EmployeeRow>;
  update(id: string, patch: EmployeeUpdateInput): Promise<EmployeeRow | null>;
  /** BR-EMP-006's account link, written after `createUserForEmployee` returns. */
  linkUser(id: string, userId: string): Promise<void>;
  setStatus(id: string, status: EmployeeStatus): Promise<void>;
  /** Mirrors `employees.employment_type` onto the contract current today (BR-EMP-007). */
  setEmploymentType(id: string, kind: 'pkwt' | 'pkwtt'): Promise<void>;
  softDelete(id: string): Promise<boolean>;
}

export const CONTRACT_REPOSITORY = Symbol('CONTRACT_REPOSITORY');

export interface ContractRepositoryPort {
  listFor(employeeId: string): Promise<ContractRow[]>;
  findById(id: string): Promise<ContractRow | null>;
  /** The row covering `date`, which is what `employees.employment_type` mirrors. */
  currentAt(employeeId: string, date: string): Promise<ContractRow | null>;
  /** The grid's `contractEndDate` column, one query for the page (N+1 discipline). */
  currentAtBatch(employeeIds: string[], date: string): Promise<Map<string, ContractRow>>;
  create(values: Omit<ContractRow, 'id' | 'lastRemindedDays' | 'createdBy'>): Promise<ContractRow>;
  update(
    id: string,
    patch: Partial<Pick<ContractRow, 'startDate' | 'endDate' | 'fileId' | 'note'>>,
  ): Promise<ContractRow | null>;
  softDelete(id: string): Promise<boolean>;
  countFor(employeeId: string): Promise<number>;
}

export const STATUS_HISTORY_REPOSITORY = Symbol('STATUS_HISTORY_REPOSITORY');

export interface NewStatusHistory {
  employeeId: string;
  status: EmployeeStatus;
  source: StatusSource;
  sourceId?: string | null;
  effectiveDate: string;
  reason?: string | null;
  /** Set when the transition is applied in the same act that records it. */
  appliedAt?: Date | null;
}

export interface StatusHistoryRepositoryPort {
  listFor(employeeId: string): Promise<StatusHistoryRow[]>;
  insert(row: NewStatusHistory): Promise<StatusHistoryRow>;
  /** UC-EMP-007's scan: unapplied and due, oldest effective date first. */
  due(onOrBefore: string): Promise<StatusHistoryRow[]>;
  /** BR-EMP-005 — one pending terminal transition at a time. */
  pendingTerminalFor(employeeId: string): Promise<StatusHistoryRow | null>;
  /** Every live row for a source, applied or not — `cancelLeaveStatus` needs both. */
  forSource(sourceId: string): Promise<StatusHistoryRow[]>;
  /**
   * Claims the row. `false` means another run already applied it, which is the
   * whole of UC-EMP-007's idempotency — the guard is `applied_at IS NULL` in the
   * `UPDATE`, so two concurrent runners serialize on the row lock and exactly
   * one of them proceeds to the side effects.
   */
  markApplied(id: string, at: Date): Promise<boolean>;
  /** A cancelled schedule is a soft-deleted row (§4.1). */
  cancel(id: string): Promise<boolean>;
}

export const FAMILY_REPOSITORY = Symbol('FAMILY_REPOSITORY');

export interface FamilyRepositoryPort {
  listFor(employeeId: string): Promise<FamilyMemberRow[]>;
  findById(id: string): Promise<FamilyMemberRow | null>;
  create(values: Omit<FamilyMemberRow, 'id'>): Promise<FamilyMemberRow>;
  update(
    id: string,
    patch: Partial<Omit<FamilyMemberRow, 'id' | 'employeeId'>>,
  ): Promise<FamilyMemberRow | null>;
  softDelete(id: string): Promise<boolean>;
}

export const EMPLOYEE_NUMBER_COUNTER = Symbol('EMPLOYEE_NUMBER_COUNTER');

/**
 * database-conventions §6 — a per-tenant counters table read `FOR UPDATE`
 * inside the creating transaction. Never `MAX()+1` (racy) and never a sequence
 * (leaks cross-tenant volume through the gaps).
 */
export interface EmployeeNumberCounterPort {
  next(companyId: string): Promise<string>;
}

export const DIRECTORY_READER = Symbol('DIRECTORY_READER');

/** Reads of this module's own published view, for its own surfaces. */
export interface DirectoryReaderPort {
  byEmployeeIds(ids: string[]): Promise<DirectoryRow[]>;
  byUserIds(userIds: string[]): Promise<DirectoryRow[]>;
}

export const EMPLOYEE_OUTBOX = Symbol('EMPLOYEE_OUTBOX');

/** §12's one event, named rather than typed loose (coding-standards-nestjs §7). */
export interface EmployeeOutboxPort {
  emit(event: {
    name: 'employee.status.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
