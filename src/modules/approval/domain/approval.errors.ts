import { AppError } from '../../../shared/app-error';
import type { InstanceStatus } from './approval.types';

/**
 * §11's `APRV_` codes — all seven, and all seven are reachable from this module.
 *
 * That is worth stating because employee shipped three of five: a factory for a
 * code nothing can raise is the permanent orphan testing-strategy §4.4 makes a
 * build failure. Here every condition has a caller, including the two-gate 403
 * and the version-loss 409, because the engine owns both gates' second half.
 */
export const approvalErrors = {
  /** BR-APRV-002 — no company chain, no tenant chain, not even a default. */
  noChainConfigured: (params: { requestType: string }) =>
    new AppError('APRV_NO_CHAIN_CONFIGURED', params),
  /**
   * BR-APRV-012, gate two. The actor holds the module's permission — gate one
   * passed at the module's own endpoint — and is not a live assignee of the
   * active step. 403 rather than 404 because the caller can already see the
   * request; it is the *act* that is refused, not the row that is hidden.
   */
  notAnApprover: () => new AppError('APRV_NOT_AN_APPROVER'),
  /** BR-APRV-013 — optimistic-version loss on a concurrent assignee/step action. */
  stepAlreadyDecided: () => new AppError('APRV_STEP_ALREADY_DECIDED'),
  /** BR-APRV-013 — any action on a terminal instance. */
  instanceNotActionable: (params: { status: InstanceStatus }) =>
    new AppError('APRV_INSTANCE_NOT_ACTIONABLE', params),
  /**
   * BR-APRV-008. Business rather than transport: a DTO carrying `comment: ''`
   * is a valid request shape, and the rule that a rejection must say why is the
   * engine's, not the wire's.
   */
  commentRequired: () => new AppError('APRV_COMMENT_REQUIRED'),
  /** UC-APRV-006 — delegating to yourself is a no-op dressed as a grant. */
  selfDelegation: () => new AppError('APRV_SELF_DELEGATION'),
  /** UC-APRV-006 — two live delegations covering one range is an ambiguous approver. */
  delegationOverlap: (params: { conflictingDelegationId: string }) =>
    new AppError('APRV_DELEGATION_OVERLAP', params),
} as const;

export const approvalErrorStatus = {
  APRV_NO_CHAIN_CONFIGURED: 422,
  APRV_NOT_AN_APPROVER: 403,
  APRV_STEP_ALREADY_DECIDED: 409,
  APRV_INSTANCE_NOT_ACTIONABLE: 409,
  APRV_COMMENT_REQUIRED: 422,
  APRV_SELF_DELEGATION: 422,
  APRV_DELEGATION_OVERLAP: 409,
} as const;
