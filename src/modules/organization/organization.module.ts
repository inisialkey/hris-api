import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { NeverLockedPeriods, PERIOD_LOCK_PORT } from '../../shared/period-lock.port';
import { AuditModule, registerAuditedTables } from '../audit';
import { AuthzModule } from '../authz';
import { BranchService } from './application/branch.service';
import { CompanyService } from './application/company.service';
import { DepartmentService } from './application/department.service';
import { JobLevelService } from './application/job-level.service';
import { MoveUseCase } from './application/move.use-case';
import { OrgPlacementService } from './application/org-placement.service';
import { OrgQueryService } from './application/org-query.service';
import { PositionService } from './application/position.service';
import { organizationErrorStatus } from './domain/organization.errors';
import {
  ASSIGNMENT_REPOSITORY,
  BRANCH_REPOSITORY,
  COMPANY_REPOSITORY,
  DEPARTMENT_REPOSITORY,
  EMPLOYEE_LOOKUP,
  JOB_LEVEL_REPOSITORY,
  ORGANIZATION_OUTBOX,
  ORG_PLACEMENT_PORT,
  ORG_QUERY_PORT,
  PLACEMENT_CACHE,
  POSITION_REPOSITORY,
} from './domain/organization.ports';
import { AssignmentRepository } from './infrastructure/assignment.repository';
import { BranchRepository } from './infrastructure/branch.repository';
import { CompanyRepository } from './infrastructure/company.repository';
import { DepartmentRepository } from './infrastructure/department.repository';
import { EmployeeLookupRepository } from './infrastructure/employee-lookup.repository';
import { JobLevelRepository } from './infrastructure/job-level.repository';
import { PlacementCache } from './infrastructure/placement-cache.service';
import { PositionRepository } from './infrastructure/position.repository';
import { CompaniesController } from './presentation/companies.controller';
import {
  OrgAssignmentsController,
  OrganizationChartController,
} from './presentation/org-assignments.controller';
import {
  BranchesController,
  DepartmentsController,
  JobLevelsController,
  PositionsController,
} from './presentation/structure.controller';

registerErrorStatuses(organizationErrorStatus);

/**
 * BR-ORG-009 — all six owned tables audited channel 1 with full diffs, appended
 * to audit-log §4.2 in the session that introduced them. Registering here rather
 * than in the repositories is what makes the §4.2 gate meaningful: the entries
 * exist before any repository is constructed, and a table added later without one
 * throws at module init instead of shipping an unclassified diff.
 *
 * Every note is empty. Nothing in this module is ADR-0016 encrypted and nothing
 * is masked — structure and placement are exactly the facts the trail exists to
 * record.
 */
registerAuditedTables({
  companies: {},
  branches: {},
  departments: {},
  job_levels: {},
  positions: {},
  org_assignments: {},
});

/**
 * `ORG_QUERY_PORT` and `ORG_PLACEMENT_PORT` are the module's whole outward
 * surface (BR-ORG-010): eleven module documents consume the first, and employee
 * plus recruitment reach the second from inside their own transactions. Nothing
 * else leaves — no module joins these tables directly.
 */
@Module({
  imports: [AuditModule, AuthzModule],
  controllers: [
    CompaniesController,
    BranchesController,
    DepartmentsController,
    JobLevelsController,
    PositionsController,
    OrgAssignmentsController,
    OrganizationChartController,
  ],
  providers: [
    CompanyService,
    BranchService,
    DepartmentService,
    JobLevelService,
    PositionService,
    MoveUseCase,
    OrgQueryService,
    OrgPlacementService,

    { provide: ORG_QUERY_PORT, useExisting: OrgQueryService },
    { provide: ORG_PLACEMENT_PORT, useExisting: OrgPlacementService },

    { provide: COMPANY_REPOSITORY, useClass: CompanyRepository },
    { provide: BRANCH_REPOSITORY, useClass: BranchRepository },
    { provide: DEPARTMENT_REPOSITORY, useClass: DepartmentRepository },
    { provide: JOB_LEVEL_REPOSITORY, useClass: JobLevelRepository },
    { provide: POSITION_REPOSITORY, useClass: PositionRepository },
    { provide: ASSIGNMENT_REPOSITORY, useClass: AssignmentRepository },
    // A-194: replaced by employee.md's facade the day it lands.
    { provide: EMPLOYEE_LOOKUP, useClass: EmployeeLookupRepository },
    { provide: PLACEMENT_CACHE, useClass: PlacementCache },
    { provide: ORGANIZATION_OUTBOX, useExisting: OutboxRepository },
    // The sanctioned stub (implementation-roadmap §4.2). attendance.md §4.2 owns
    // the real one; until it ships, every date is open.
    { provide: PERIOD_LOCK_PORT, useClass: NeverLockedPeriods },
  ],
  exports: [ORG_QUERY_PORT, ORG_PLACEMENT_PORT],
})
export class OrganizationModule {}
