import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { ORG_QUERY_PORT, type OrgQueryPort, type Placement } from '../../organization';
import {
  CONTRACT_REPOSITORY,
  type ContractRepositoryPort,
  DIRECTORY_READER,
  type DirectoryReaderPort,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepositoryPort,
  FAMILY_REPOSITORY,
  type FamilyRepositoryPort,
} from '../domain/employee.ports';
import type { ContractRow, EmployeeRow, FamilyMemberRow } from '../domain/employee.types';

export interface ManagerSummary {
  name: string;
  positionTitle: string;
}

export interface OwnProfile {
  employee: EmployeeRow;
  placement: Placement | null;
  manager: ManagerSummary | null;
  currentContract: ContractRow | null;
  familyMembers: FamilyMemberRow[];
  /**
   * §7 fills this from `LeaveQueryPort.balanceFor`. leave.md is further down the
   * spine, so it is `null` today for a second reason the contract already allows
   * for — A-195 names it so the gap is a list entry rather than a discovery.
   */
  leaveSummary: null;
}

export interface TeamMember {
  employeeId: string;
  fullName: string;
  positionTitle: string;
  branchName: string;
  status: string;
}

/**
 * §7's `/me` surfaces: the mobile bootstrap read and the manager team list.
 *
 * Both are `@AuthenticatedOnly()` — no permission key, because self and team are
 * data scope by construction (BR-AUTHZ-009). The scope check is the lookup
 * itself: a caller resolves to exactly one employee row, or to none.
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepositoryPort,
    @Inject(FAMILY_REPOSITORY) private readonly family: FamilyRepositoryPort,
    @Inject(DIRECTORY_READER) private readonly directory: DirectoryReaderPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
  ) {}

  async ownProfile(userId: string, asOf: string): Promise<Result<OwnProfile>> {
    const employee = await this.employees.findByUserId(userId);
    if (!employee) return fail(sharedErrors.notFound());

    const placement = await this.org.placement(employee.id, asOf);
    const currentContract = await this.contracts.currentAt(employee.id, asOf);
    const familyMembers = await this.family.listFor(employee.id);
    const manager = await this.resolveManager(employee.id, asOf);

    return ok({ employee, placement, manager, currentContract, familyMembers, leaveSummary: null });
  }

  /**
   * UC-EMP-011. Direct reports are the holders of positions reporting to a
   * position the caller holds — the org port's inverse, which is why this
   * module asks rather than walking a tree it does not own.
   *
   * No pagination (§7's stated deviation: team sizes are dozens).
   */
  async team(userId: string, asOf: string): Promise<Result<TeamMember[]>> {
    const employee = await this.employees.findByUserId(userId);
    if (!employee) return fail(sharedErrors.notFound());

    const reportIds = await this.org.directReports(employee.id, asOf);
    if (reportIds.length === 0) return ok([]);

    const rows = await this.directory.byEmployeeIds(reportIds);
    const placements = await this.org.placements(reportIds, asOf);

    return ok(
      rows.map((row) => ({
        employeeId: row.employeeId,
        fullName: row.fullName,
        positionTitle: placements.get(row.employeeId)?.positionTitle ?? '',
        branchName: placements.get(row.employeeId)?.branchName ?? '',
        status: row.status,
      })),
    );
  }

  /**
   * **A manager without a login reads as no manager here, and that is a
   * narrowing rather than the rule** (A-195). `OrgQueryPort.directManagers`
   * answers in *user* ids because its designed caller is the approval engine,
   * where a manager who cannot log in cannot be assigned a step — BR-ORG-003's
   * account filter is correct there and wrong for a display field. Closing it
   * means an employee-shaped projection on that port, which is organization's
   * contract to change, not this module's to work around.
   */
  private async resolveManager(employeeId: string, asOf: string): Promise<ManagerSummary | null> {
    const userIds = await this.org.directManagers(employeeId, 1, asOf);
    if (userIds.length === 0) return null;

    const rows = await this.directory.byUserIds(userIds);
    const manager = rows[0];
    if (!manager) return null;

    const placement = await this.org.placement(manager.employeeId, asOf);
    return { name: manager.fullName, positionTitle: placement?.positionTitle ?? '' };
  }
}
