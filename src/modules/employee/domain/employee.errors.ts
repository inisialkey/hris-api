import { AppError } from '../../../shared/app-error';
import type { EmployeeStatus } from './employee.types';

/**
 * §11's `EMP_` codes.
 *
 * **Three of the catalog's five, and the other two are absent on purpose.**
 * `EMP_DATA_CHANGE_PENDING` and `EMP_RESIGNATION_PENDING` guard BR-EMP-009 and
 * BR-EMP-010, both of which route through the approval engine — spine order 4,
 * one step after this module. A factory for a code nothing can raise is exactly
 * the permanent orphan testing-strategy §4.4 makes a build failure, so they
 * arrive with their use cases rather than as dead constants. The catalog rows
 * stay; codes are immortal from registration, not from first throw (ADR-0006).
 */
export const employeeErrors = {
  /** BR-EMP-013 — an active employee is terminated first, never deleted. */
  stillActive: (params: { currentStatus: EmployeeStatus }) =>
    new AppError('EMP_STILL_ACTIVE', params),
  /** BR-EMP-005/006 — outside the machine, or a second terminal schedule. */
  statusTransitionInvalid: (params: { currentStatus: EmployeeStatus }) =>
    new AppError('EMP_STATUS_TRANSITION_INVALID', params),
  /** BR-EMP-007 — the gist exclusion, surfaced. */
  contractOverlap: (params: { conflictingContractId: string | null }) =>
    new AppError('EMP_CONTRACT_OVERLAP', params),
} as const;

export const employeeErrorStatus = {
  EMP_STILL_ACTIVE: 409,
  EMP_STATUS_TRANSITION_INVALID: 409,
  EMP_CONTRACT_OVERLAP: 409,
} as const;
