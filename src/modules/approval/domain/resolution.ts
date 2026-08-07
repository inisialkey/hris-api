import type { DelegationRow, SelfApprovalPolicy } from './approval.types';

/**
 * The pure half of step activation. The async half — walking the reporting line,
 * reading role holders — lives in `application/activation.service.ts`, which has
 * the ports; everything that is a *decision* rather than a lookup is here, so
 * BR-APRV-007 and BR-APRV-009 can be tested without a database.
 */

export type SelfApprovalOutcome =
  | { kind: 'assign'; users: string[] }
  /** BR-APRV-007 `skip_step` — the step is decided without an approver. */
  | { kind: 'skip' }
  /** BR-APRV-007 default — the caller walks one level further up the line. */
  | { kind: 'reroute' };

/**
 * BR-APRV-007, and the ordering that makes it behave sensibly on a mixed set.
 *
 * The guard only fires when the requester is *in* the resolved set. Two holders
 * of a position where one is the requester leaves one approver who is not the
 * subject — that is a valid step, not a reroute, and rerouting it would take a
 * decision away from someone entitled to make it.
 *
 * `allow` is never a default (ADR-0008) and is not treated as one here: it is
 * the only branch that returns the requester as their own approver.
 */
export function applySelfApproval(
  users: readonly string[],
  requesterUserId: string,
  policy: SelfApprovalPolicy,
): SelfApprovalOutcome {
  if (policy === 'allow' || !users.includes(requesterUserId)) {
    return { kind: 'assign', users: [...users] };
  }

  const others = users.filter((userId) => userId !== requesterUserId);
  if (others.length > 0) return { kind: 'assign', users: others };

  return policy === 'skip_step' ? { kind: 'skip' } : { kind: 'reroute' };
}

export interface Assignment {
  approverUserId: string;
  /** BR-APRV-009 — the original approver, kept for their read visibility. */
  delegateOfUserId: string | null;
}

/**
 * BR-APRV-009: resolve the original approver, then re-point the item to the live
 * delegate. **Exactly once** — the delegate's own delegation is not consulted,
 * which is what makes the rule loop-proof by construction rather than by a cycle
 * check.
 *
 * Two originals delegating to one person collapse to a single item, because
 * `uq_approval_assignees_step_user` says a user holds one seat on a step and
 * because two inbox rows for one decision would be two things to act on and one
 * action. The surviving row keeps the **first** original it was redirected from;
 * both originals keep read visibility through the instance's step list either
 * way.
 */
export function redirectDelegations(
  users: readonly string[],
  delegations: readonly DelegationRow[],
  requestType: string,
  today: string,
): Assignment[] {
  const seats = new Map<string, Assignment>();

  for (const userId of users) {
    const delegation = liveDelegationFor(delegations, userId, requestType, today);
    const approverUserId = delegation?.delegateUserId ?? userId;
    if (seats.has(approverUserId)) continue;
    seats.set(approverUserId, {
      approverUserId,
      delegateOfUserId: delegation ? userId : null,
    });
  }

  return [...seats.values()];
}

/**
 * Inclusive on both ends — a delegation "1–5 March" covers 5 March, which is what
 * an admin filling in a leave form means and what §14's boundary scenario tests.
 * Revoked rows are dead for future activations only (UC-APRV-006); an item
 * already assigned to the delegate stays theirs.
 */
export function liveDelegationFor(
  delegations: readonly DelegationRow[],
  delegatorUserId: string,
  requestType: string,
  today: string,
): DelegationRow | null {
  const candidates = delegations.filter(
    (row) =>
      row.delegatorUserId === delegatorUserId &&
      row.revokedAt === null &&
      row.startDate <= today &&
      today <= row.endDate &&
      (row.requestTypes === null || row.requestTypes.includes(requestType)),
  );
  // Newest wins when the overlap pre-check lost a race. Deterministic beats
  // arbitrary: an ambiguous approver is worse than a debatable one.
  return candidates.sort((a, b) => b.id.localeCompare(a.id))[0] ?? null;
}

/**
 * UC-APRV-006's overlap test, as the pre-check the 409 is raised from.
 *
 * Two delegations overlap when their date ranges intersect **and** their type
 * scopes do: `NULL` means every type, so a null on either side always
 * intersects. A March delegation for `leave.request` and a March delegation for
 * `expense.claim` are not a conflict — they are how a delegator splits their
 * inbox.
 */
export function overlapping(
  existing: readonly DelegationRow[],
  candidate: { startDate: string; endDate: string; requestTypes: string[] | null },
): DelegationRow | null {
  return (
    existing.find(
      (row) =>
        row.revokedAt === null &&
        row.startDate <= candidate.endDate &&
        candidate.startDate <= row.endDate &&
        typesIntersect(row.requestTypes, candidate.requestTypes),
    ) ?? null
  );
}

function typesIntersect(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return true;
  return a.some((type) => b.includes(type));
}
