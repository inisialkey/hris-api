/** Row shapes the module passes around, independent of Drizzle's inferred types. */

export type OrgAssignmentKind = 'hire' | 'transfer' | 'promotion' | 'correction';

export interface CompanyRow {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  npwp: string | null;
  address: string | null;
  phone: string | null;
  updatedAt: Date;
}

export interface BranchRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  timezone: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
}

export interface DepartmentRow {
  id: string;
  companyId: string;
  parentDepartmentId: string | null;
  code: string;
  name: string;
}

export interface JobLevelRow {
  id: string;
  code: string;
  name: string;
  rank: number;
}

export interface PositionRow {
  id: string;
  companyId: string;
  departmentId: string;
  jobLevelId: string;
  code: string;
  title: string;
  reportsToPositionId: string | null;
}

export interface AssignmentRow {
  id: string;
  employeeId: string;
  positionId: string;
  branchId: string;
  kind: OrgAssignmentKind;
  note: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface MoveRequest {
  positionId: string;
  branchId: string;
  kind: OrgAssignmentKind;
  note?: string;
  /** `YYYY-MM-DD`. Today for an immediate move, a later date to schedule one. */
  effectiveFrom: string;
}

/** UC-ORG-001's answer — everything a consumer needs without joining org tables. */
/**
 * A live placement, as `OrgQueryPort` hands it over.
 *
 * **The display names are part of the contract and not a convenience**
 * (added by employee.md's arrival — A-195). As originally written this type
 * carried ids only, which made both of employee.md §7's placement shapes
 * unimplementable: the grid renders `{ positionTitle, branchName,
 * departmentName }` and `/me/profile` renders six names, and neither has a
 * sanctioned channel to resolve an id into a name — `employee_directory` is
 * about employees, and joining organization's tables is the ADR-0001 rule 2
 * violation the port exists to prevent. Resolving them here costs three extra
 * joins on a query that already made two, over a page of at most a hundred rows.
 * Additive: every existing consumer reads the same ids it always did.
 */
export interface Placement {
  companyId: string;
  companyName: string;
  branchId: string;
  branchName: string;
  branchTimezone: string;
  departmentId: string;
  departmentName: string;
  positionId: string;
  positionTitle: string;
  jobLevelId: string;
  jobLevelName: string;
}

/** One node of UC-ORG-006's flat chart; the client builds the forest from the edges. */
export interface ChartNode {
  positionId: string;
  code: string;
  title: string;
  departmentId: string;
  departmentName: string;
  jobLevelId: string;
  rank: number;
  reportsToPositionId: string | null;
  holders: { employeeId: string; fullName: string }[];
  vacant: boolean;
}

/** BR-ORG-006's `details.blockers` — the counts a confirm dialog renders. */
export interface ArchiveBlocker {
  type: string;
  count: number;
}
