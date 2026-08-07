import type { AssigneeRow, DelegationRow } from './approval.types';
import { stepOutcome } from './quorum';
import {
  applySelfApproval,
  liveDelegationFor,
  overlapping,
  redirectDelegations,
} from './resolution';

describe('self-approval guard (BR-APRV-007)', () => {
  const REQUESTER = 'u-requester';

  it('does nothing when the requester is not among the approvers', () => {
    expect(applySelfApproval(['u-1', 'u-2'], REQUESTER, 'reroute_next_level')).toEqual({
      kind: 'assign',
      users: ['u-1', 'u-2'],
    });
  });

  it('keeps the other holders instead of rerouting a mixed set', () => {
    // Two holders of one position, one of them the subject: the other is a valid
    // approver and rerouting would take the decision away from them.
    expect(applySelfApproval(['u-1', REQUESTER], REQUESTER, 'reroute_next_level')).toEqual({
      kind: 'assign',
      users: ['u-1'],
    });
  });

  it('reroutes when the requester was the only approver', () => {
    expect(applySelfApproval([REQUESTER], REQUESTER, 'reroute_next_level')).toEqual({
      kind: 'reroute',
    });
  });

  it('skips the step under `skip_step`', () => {
    expect(applySelfApproval([REQUESTER], REQUESTER, 'skip_step')).toEqual({ kind: 'skip' });
  });

  it('lets the requester act under `allow`, which is never a default', () => {
    expect(applySelfApproval([REQUESTER], REQUESTER, 'allow')).toEqual({
      kind: 'assign',
      users: [REQUESTER],
    });
  });
});

describe('delegation redirect (BR-APRV-009)', () => {
  const TODAY = '2026-03-10';

  const delegation = (over: Partial<DelegationRow> & { id: string }): DelegationRow => ({
    delegatorUserId: 'u-1',
    delegateUserId: 'u-2',
    requestTypes: null,
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    revokedAt: null,
    ...over,
  });

  it('re-points the item and records who it was originally for', () => {
    expect(
      redirectDelegations(['u-1'], [delegation({ id: 'd-1' })], 'leave.request', TODAY),
    ).toEqual([{ approverUserId: 'u-2', delegateOfUserId: 'u-1' }]);
  });

  it('never cascades — A→B and B→C sends A to B only', () => {
    const rows = [
      delegation({ id: 'd-1', delegatorUserId: 'a', delegateUserId: 'b' }),
      delegation({ id: 'd-2', delegatorUserId: 'b', delegateUserId: 'c' }),
    ];
    expect(redirectDelegations(['a'], rows, 'leave.request', TODAY)).toEqual([
      { approverUserId: 'b', delegateOfUserId: 'a' },
    ]);
  });

  it('collapses two originals delegating to one person into one seat', () => {
    // `uq_approval_assignees_step_user` says a user holds one seat on a step, and
    // two inbox rows for one decision would be two things to act on and one act.
    const rows = [
      delegation({ id: 'd-1', delegatorUserId: 'a', delegateUserId: 'z' }),
      delegation({ id: 'd-2', delegatorUserId: 'b', delegateUserId: 'z' }),
    ];
    expect(redirectDelegations(['a', 'b'], rows, 'leave.request', TODAY)).toEqual([
      { approverUserId: 'z', delegateOfUserId: 'a' },
    ]);
  });

  it('honours the window on both boundary days and outside them', () => {
    const rows = [delegation({ id: 'd-1', startDate: '2026-03-01', endDate: '2026-03-05' })];
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', '2026-03-01')).not.toBeNull();
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', '2026-03-05')).not.toBeNull();
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', '2026-02-28')).toBeNull();
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', '2026-03-06')).toBeNull();
  });

  it('applies a type subset only to the types it names', () => {
    const rows = [delegation({ id: 'd-1', requestTypes: ['expense.claim'] })];
    expect(liveDelegationFor(rows, 'u-1', 'expense.claim', TODAY)).not.toBeNull();
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', TODAY)).toBeNull();
  });

  it('treats a revoked delegation as dead for future activations', () => {
    const rows = [delegation({ id: 'd-1', revokedAt: new Date('2026-03-05T00:00:00Z') })];
    expect(liveDelegationFor(rows, 'u-1', 'leave.request', TODAY)).toBeNull();
  });
});

describe('delegation overlap (UC-APRV-006)', () => {
  const existing: DelegationRow = {
    id: 'd-1',
    delegatorUserId: 'u-1',
    delegateUserId: 'u-2',
    requestTypes: null,
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    revokedAt: null,
  };

  it('reports the conflicting row when the ranges intersect', () => {
    expect(
      overlapping([existing], {
        startDate: '2026-03-31',
        endDate: '2026-04-10',
        requestTypes: null,
      })?.id,
    ).toBe('d-1');
  });

  it('allows an adjacent range', () => {
    expect(
      overlapping([existing], {
        startDate: '2026-04-01',
        endDate: '2026-04-10',
        requestTypes: null,
      }),
    ).toBeNull();
  });

  it('allows two type-disjoint delegations over the same dates', () => {
    // Splitting an inbox is what a type subset is for, not a conflict.
    const typed = { ...existing, requestTypes: ['leave.request'] };
    expect(
      overlapping([typed], {
        startDate: '2026-03-05',
        endDate: '2026-03-10',
        requestTypes: ['expense.claim'],
      }),
    ).toBeNull();
  });

  it('treats a null scope as covering every type on either side', () => {
    expect(
      overlapping([existing], {
        startDate: '2026-03-05',
        endDate: '2026-03-10',
        requestTypes: ['expense.claim'],
      })?.id,
    ).toBe('d-1');
  });
});

describe('quorum (BR-APRV-008)', () => {
  const seat = (status: AssigneeRow['status']): AssigneeRow => ({
    id: `a-${status}-${Math.random()}`,
    stepId: 's-1',
    approverUserId: 'u',
    delegateOfUserId: null,
    status,
    actedAt: null,
    version: 1,
  });

  it('decides an `any` step on the first approval', () => {
    expect(stepOutcome([seat('approved'), seat('active')], 'any')).toBe('approved');
  });

  it('holds an `all` step open on a partial approval', () => {
    expect(stepOutcome([seat('approved'), seat('active')], 'all')).toBe('active');
  });

  it('closes an `all` step when the last approval lands', () => {
    expect(stepOutcome([seat('approved'), seat('approved')], 'all')).toBe('approved');
  });

  it('lets one rejection terminate an `all` step whatever else approved', () => {
    expect(stepOutcome([seat('approved'), seat('rejected'), seat('active')], 'all')).toBe(
      'rejected',
    );
  });

  it('does not treat a closed-out seat as an approval', () => {
    expect(stepOutcome([seat('skipped'), seat('active')], 'any')).toBe('active');
  });
});
