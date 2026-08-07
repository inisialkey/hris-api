import type { AssigneeRow, Quorum } from './approval.types';

/**
 * BR-APRV-008, evaluated over the step's assignee rows **after** the acting one
 * has been claimed. The claim is what makes this a pure function: the caller has
 * already won or lost the version check, so this only has to read the outcome.
 */
export type StepOutcome = 'approved' | 'rejected' | 'active';

/**
 * `any` — the first action decides the step.
 * `all` — every assignee must approve; **any** reject terminates.
 *
 * Reject is checked before approve for both quorums, and that ordering is the
 * rule rather than defensive coding: BR-APRV-008 makes a rejection terminal for
 * the *instance* at any step, so an `all` step with one rejection and three
 * approvals is rejected, not pending on the fourth.
 */
export function stepOutcome(assignees: readonly AssigneeRow[], quorum: Quorum): StepOutcome {
  if (assignees.some((row) => row.status === 'rejected')) return 'rejected';

  const approvals = assignees.filter((row) => row.status === 'approved').length;
  if (approvals === 0) return 'active';

  if (quorum === 'any') return 'approved';
  return assignees.every((row) => row.status === 'approved') ? 'approved' : 'active';
}
