import type { Placement } from '../../organization';
import type { EmployeeDetail, EmployeeListEntry } from '../application/employee.service';
import type { OwnProfile } from '../application/profile.service';
import { maskEmployee } from '../domain/masking';

/**
 * The presentation boundary where BR-EMP-003 is applied.
 *
 * Masking lives here rather than in the services for one reason: the reveal
 * endpoints reuse the *same* reads, so a service that masked would need a second
 * unmasked read beside it, and two reads of one table eventually disagree about
 * which fields exist. One read, two mappers, and the mapper a new endpoint
 * reaches for by default is the masked one.
 */

function placementSummary(placement: Placement | null) {
  if (!placement) return null;
  return {
    companyId: placement.companyId,
    companyName: placement.companyName,
    branchId: placement.branchId,
    branchName: placement.branchName,
    branchTimezone: placement.branchTimezone,
    departmentId: placement.departmentId,
    departmentName: placement.departmentName,
    positionId: placement.positionId,
    positionTitle: placement.positionTitle,
    jobLevelId: placement.jobLevelId,
    jobLevelName: placement.jobLevelName,
  };
}

/**
 * §7's list row. The encrypted set is absent rather than masked (§4.3) and it
 * was never selected — the repository's projection is the boundary, so this
 * mapper has nothing to strip.
 */
export function toListResponse(row: EmployeeListEntry) {
  const { placement, hasUser, contractEndDate, ...employee } = row;
  return {
    ...employee,
    contractEndDate,
    hasUser,
    placement: placement
      ? {
          positionTitle: placement.positionTitle,
          branchName: placement.branchName,
          departmentName: placement.departmentName,
        }
      : null,
  };
}

export function toDetailResponse(detail: EmployeeDetail) {
  return {
    ...maskEmployee(detail.employee),
    placement: placementSummary(detail.placement),
    currentContract: detail.currentContract,
    familyMembers: detail.familyMembers,
    statusHistory: detail.statusHistory,
  };
}

export function toProfileResponse(profile: OwnProfile) {
  return {
    employee: maskEmployee(profile.employee),
    placement: placementSummary(profile.placement),
    manager: profile.manager,
    currentContract: profile.currentContract,
    familyMembers: profile.familyMembers,
    leaveSummary: profile.leaveSummary,
  };
}
