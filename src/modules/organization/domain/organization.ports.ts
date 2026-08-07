import type { Result } from '../../../shared/result';
import type {
  ArchiveBlocker,
  AssignmentRow,
  BranchRow,
  ChartNode,
  CompanyRow,
  DepartmentRow,
  JobLevelRow,
  Placement,
  PositionRow,
} from './organization.types';

/* ------------------------------------------------------------------------- *
 * The consumer contracts — organization.md §4.2, verbatim.
 * ------------------------------------------------------------------------- */

export const ORG_QUERY_PORT = Symbol('ORG_QUERY_PORT');

export interface OrgQueryPort {
  /** Live placement as-of a date; null when the employee has none (pre-assignment). */
  placement(employeeId: string, asOf: string): Promise<Placement | null>;
  /** Batch form for grids (employee.md list enrichment). One query, keyed result. */
  placements(employeeIds: string[], asOf: string): Promise<Map<string, Placement | null>>;
  /** BR-ORG-003 — approval resolver `direct_manager(levels)`. User ids, subject excluded. */
  directManagers(employeeId: string, levels: number, asOf: string): Promise<string[]>;
  /** BR-ORG-003 holder rule — approval resolver `position_holder`. */
  positionHolders(positionId: string, asOf: string): Promise<string[]>;
  /**
   * approval-engine §8's resolver-ref check, added 2026-08-07 with its first
   * caller. Existence is a different question from `positionHolders` returning
   * empty — a live but vacant position is what BR-APRV-006's ladder is *for*,
   * while a deleted one is a chain that can never resolve and belongs in a field
   * entry at config-write time (A-196).
   */
  positionExists(positionId: string): Promise<boolean>;
  /**
   * The reporting line walked downwards — employee.md §13's "team inverse",
   * added 2026-08-06 with its first caller (UC-EMP-011). **Employee** ids, not
   * user ids: a direct report with no login is still a direct report, and the
   * account filter on `directManagers` exists for the approval engine rather
   * than for a roster.
   */
  directReports(employeeId: string, asOf: string): Promise<string[]>;
  /**
   * Audience resolution over placement (announcement.md BR-ANN-002).
   * Rules union; a `departmentIds` entry **descends its subtree**, `positionIds`
   * and `jobLevelIds` match exactly. An empty rule set means everyone in scope.
   * `companyId: null` = tenant-wide, and requires the caller to hold tenant data
   * scope. Returns employee ids only — the caller maps to users through
   * `employee_directory`.
   */
  audienceEmployeeIds(rules: AudienceRules, asOf: string): Promise<string[]>;
}

export interface AudienceRules {
  companyId: string | null;
  branchIds?: string[];
  departmentIds?: string[];
  positionIds?: string[];
  jobLevelIds?: string[];
}

export const ORG_PLACEMENT_PORT = Symbol('ORG_PLACEMENT_PORT');

export interface OrgPlacementPort {
  /**
   * Mandatory at employee creation (BR-ORG-002): seeds the initial placement
   * inside the caller's transaction (employee.md hire, recruitment.md
   * conversion). kind = 'hire'.
   */
  assignOnHire(
    employeeId: string,
    positionId: string,
    branchId: string,
    effectiveFrom: string,
  ): Promise<Result<void>>;
  /**
   * Terminal status effectuation (employee.md BR-EMP-006): closes the live
   * assignment at the exit date inside the caller's transaction. No-op when none
   * is live.
   */
  closeOnExit(employeeId: string, effectiveDate: string): Promise<Result<void>>;
}

/* ------------------------------------------------------------------------- *
 * Internal ports — the module's own seams, not a cross-module surface.
 * ------------------------------------------------------------------------- */

/** Offset pagination, api-standards §5.3. */
export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export const COMPANY_REPOSITORY = Symbol('COMPANY_REPOSITORY');

export interface CompanyRepositoryPort {
  list(filter: { q?: string; companyIds: string[] | null }, page: Page): Promise<Paged<CompanyRow>>;
  counts(
    companyIds: string[],
  ): Promise<Map<string, { branchCount: number; employeeCount: number }>>;
  findById(id: string): Promise<CompanyRow | null>;
  findByCode(code: string): Promise<CompanyRow | null>;
  create(values: Omit<CompanyRow, 'id' | 'updatedAt'>): Promise<CompanyRow>;
  update(id: string, patch: Partial<Omit<CompanyRow, 'id' | 'code'>>): Promise<CompanyRow | null>;
  archive(id: string): Promise<boolean>;
  /** BR-ORG-006's blocker set for a company, counted rather than merely detected. */
  archiveBlockers(id: string): Promise<ArchiveBlocker[]>;
}

export const BRANCH_REPOSITORY = Symbol('BRANCH_REPOSITORY');

export interface BranchRepositoryPort {
  list(filter: { companyId: string; q?: string }, page: Page): Promise<Paged<BranchRow>>;
  assignmentCounts(branchIds: string[]): Promise<Map<string, number>>;
  findById(id: string): Promise<BranchRow | null>;
  findByCode(companyId: string, code: string): Promise<BranchRow | null>;
  create(values: Omit<BranchRow, 'id'>): Promise<BranchRow>;
  update(
    id: string,
    patch: Partial<Omit<BranchRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<BranchRow | null>;
  archive(id: string): Promise<boolean>;
  archiveBlockers(id: string): Promise<ArchiveBlocker[]>;
}

export const DEPARTMENT_REPOSITORY = Symbol('DEPARTMENT_REPOSITORY');

export interface DepartmentRepositoryPort {
  list(filter: { companyId: string }, page: Page): Promise<Paged<DepartmentRow>>;
  /** Every live department of a company — the edge set BR-ORG-004 walks. */
  listAll(companyId: string): Promise<DepartmentRow[]>;
  positionCounts(departmentIds: string[]): Promise<Map<string, number>>;
  findById(id: string): Promise<DepartmentRow | null>;
  findByCode(companyId: string, code: string): Promise<DepartmentRow | null>;
  create(values: Omit<DepartmentRow, 'id'>): Promise<DepartmentRow>;
  update(
    id: string,
    patch: Partial<Omit<DepartmentRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<DepartmentRow | null>;
  archive(id: string): Promise<boolean>;
  archiveBlockers(id: string): Promise<ArchiveBlocker[]>;
  /** Subtree ids including the root — announcement targeting descends this. */
  descendantIds(departmentIds: string[]): Promise<string[]>;
}

export const JOB_LEVEL_REPOSITORY = Symbol('JOB_LEVEL_REPOSITORY');

export interface JobLevelRepositoryPort {
  /** Tenant-wide and unpaginated (§7 — dozens of rows, deliberate deviation). */
  list(): Promise<JobLevelRow[]>;
  positionCounts(jobLevelIds: string[]): Promise<Map<string, number>>;
  findById(id: string): Promise<JobLevelRow | null>;
  findByCode(code: string): Promise<JobLevelRow | null>;
  create(values: Omit<JobLevelRow, 'id'>): Promise<JobLevelRow>;
  update(id: string, patch: Partial<Omit<JobLevelRow, 'id' | 'code'>>): Promise<JobLevelRow | null>;
  archive(id: string): Promise<boolean>;
  archiveBlockers(id: string): Promise<ArchiveBlocker[]>;
}

export const POSITION_REPOSITORY = Symbol('POSITION_REPOSITORY');

export interface PositionFilter {
  companyId: string;
  departmentId?: string;
  jobLevelId?: string;
  vacant?: boolean;
  q?: string;
}

export interface PositionRepositoryPort {
  list(filter: PositionFilter, page: Page, asOf: string): Promise<Paged<PositionRow>>;
  listAll(companyId: string): Promise<PositionRow[]>;
  holderCounts(positionIds: string[], asOf: string): Promise<Map<string, number>>;
  findById(id: string): Promise<PositionRow | null>;
  findByCode(companyId: string, code: string): Promise<PositionRow | null>;
  create(values: Omit<PositionRow, 'id'>): Promise<PositionRow>;
  update(
    id: string,
    patch: Partial<Omit<PositionRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<PositionRow | null>;
  archive(id: string): Promise<boolean>;
  archiveBlockers(id: string): Promise<ArchiveBlocker[]>;
  /** UC-ORG-006 — the chart, one query per company. */
  chart(companyId: string, asOf: string): Promise<ChartNode[]>;
}

export const ASSIGNMENT_REPOSITORY = Symbol('ASSIGNMENT_REPOSITORY');

export interface AssignmentHistoryRow extends AssignmentRow {
  positionTitle: string;
  branchName: string;
  cancelled: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export interface AssignmentRepositoryPort {
  /** Live rows only — the planner's input, and the exclusion constraint's domain. */
  liveHistory(employeeId: string): Promise<AssignmentRow[]>;
  /** §7's history read: cancelled rows included and flagged. */
  fullHistory(employeeId: string): Promise<AssignmentHistoryRow[]>;
  findById(id: string): Promise<AssignmentRow | null>;
  placement(employeeId: string, asOf: string): Promise<Placement | null>;
  placements(employeeIds: string[], asOf: string): Promise<Map<string, Placement>>;
  /**
   * BR-ORG-003's holder rule: live, `active`/`on_leave`, with a user account.
   * `excludeEmployeeId` is the subject exclusion — by employee, not by user, so
   * it holds for the odd case where the requester also holds the landing position.
   */
  holderUserIds(positionIds: string[], asOf: string, excludeEmployeeId?: string): Promise<string[]>;
  /**
   * The same holder rule minus the account filter, answering in employee ids —
   * `directReports`' projection. Separate rather than a flag on the method above
   * because the two differ in *what they return* as well as in what they filter,
   * and a boolean that changes a return type is a method wearing a disguise.
   */
  holderEmployeeIds(
    positionIds: string[],
    asOf: string,
    excludeEmployeeId?: string,
  ): Promise<string[]>;
  audienceEmployeeIds(
    rules: {
      companyId: string | null;
      branchIds?: string[];
      departmentIds?: string[];
      positionIds?: string[];
      jobLevelIds?: string[];
    },
    asOf: string,
  ): Promise<string[]>;
  /**
   * BR-ORG-008's supersede, one transaction: close the predecessor, insert the
   * successor. Callers never write the two rows independently
   * (database-conventions §5 rule 4).
   */
  supersede(
    employeeId: string,
    plan: {
      close: { id: string; effectiveTo: string } | null;
      insert: Omit<AssignmentRow, 'id' | 'employeeId'>;
    },
  ): Promise<AssignmentRow>;
  cancel(plan: {
    softDelete: string;
    reopen: { id: string; effectiveTo: string | null } | null;
  }): Promise<void>;
  /** `closeOnExit` — no-op when nothing is live on the date. */
  closeLiveAt(employeeId: string, date: string): Promise<boolean>;
}

export const EMPLOYEE_LOOKUP = Symbol('EMPLOYEE_LOOKUP');

/**
 * The one read this module makes outside its own tables, and it stays a port for
 * that reason (ADR-0001). `employees` is core-schema's and the employee module's;
 * a placement needs the company it must agree with and the join date it must not
 * precede, and nothing else. The employee module replaces this binding with its
 * own facade the day it arrives — the shape is already the subset it would expose.
 */
export interface EmployeeLookupPort {
  find(employeeId: string): Promise<{ id: string; companyId: string; joinDate: string } | null>;
  /**
   * The caller's own employee record, for UC-ORG-006's "others are forced to
   * their own company". An employee's company comes from their employment, not
   * from a role assignment they do not hold.
   */
  findByUserId(userId: string): Promise<{ id: string; companyId: string } | null>;
}

export const PLACEMENT_CACHE = Symbol('PLACEMENT_CACHE');

export interface PlacementCachePort {
  read(tenantId: string, employeeId: string): Promise<Placement | null>;
  write(tenantId: string, employeeId: string, placement: Placement): Promise<void>;
  bust(tenantId: string, employeeId: string): Promise<void>;
}

export const ORGANIZATION_OUTBOX = Symbol('ORGANIZATION_OUTBOX');

/** §12's two events, named rather than typed loose (coding-standards-nestjs §7). */
export interface OrganizationOutboxPort {
  emit(event: {
    name: 'organization.assignment.changed' | 'organization.branch.updated';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
