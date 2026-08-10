import type { ApprovalStepTasks, ApprovalTaskPort } from '../../approval';
import type { InboxRepositoryPort, NewInboxItem } from '../domain/inbox.ports';
import type { ClosedReason } from '../domain/inbox.types';
import { ApprovalTasksService } from './approval-tasks.service';

const STEP: ApprovalStepTasks = {
  instanceId: 'instance-1',
  stepId: 'step-1',
  requestType: 'leave.request',
  requestId: 'request-1',
  requesterUserId: 'user-requester',
  requesterName: 'Budi Santoso',
  context: { dayCount: 3, employeeId: 'employee-1', nested: { ignored: true } },
  dueAt: new Date('2026-03-11T02:00:00Z'),
  tasks: [
    { assigneeId: 'seat-1', userId: 'user-a', delegateOfUserId: null, delegateOfName: null },
    {
      assigneeId: 'seat-2',
      userId: 'user-delegate',
      delegateOfUserId: 'user-b',
      delegateOfName: 'Sari Wijaya',
    },
  ],
};

describe('ApprovalTasksService', () => {
  let inserted: NewInboxItem[];
  let closed: { instanceId: string; stepId: string | null; reason: ClosedReason }[];
  let completed: { userId: string; dedupeKey: string }[];
  let step: ApprovalStepTasks | null;
  let service: ApprovalTasksService;

  beforeEach(() => {
    inserted = [];
    closed = [];
    completed = [];
    step = STEP;

    const items = {
      insertIfNew: (batch: readonly NewInboxItem[]) => {
        inserted.push(...batch);
        return Promise.resolve(batch.length);
      },
      completeByDedupeKey: (userId: string, dedupeKey: string) => {
        completed.push({ userId, dedupeKey });
        return Promise.resolve(1);
      },
      closeApprovalItems: (instanceId: string, stepId: string | null, reason: ClosedReason) => {
        closed.push({ instanceId, stepId, reason });
        return Promise.resolve(2);
      },
    } as unknown as InboxRepositoryPort;

    const tasks: ApprovalTaskPort = { stepTasks: () => Promise.resolve(step) };
    service = new ApprovalTasksService(items, tasks);
  });

  it('writes one item per seat, keyed on the assignee row id', async () => {
    // BR-INB-004 — the dedupe key is the *assignee* id, not the user id, which
    // is what lets two steps of one instance both give the same person a task.
    await service.materialize('step-1');

    expect(inserted).toHaveLength(2);
    expect(inserted.map((item) => item.dedupeKey)).toEqual(['seat-1', 'seat-2']);
    expect(inserted.map((item) => item.userId)).toEqual(['user-a', 'user-delegate']);
  });

  it('renders the title from the requester and the context', async () => {
    await service.materialize('step-1');

    expect(inserted[0]!.title).toBe('Pengajuan cuti · Budi Santoso');
    expect(inserted[0]!.subtitle).toBe('3 hari');
  });

  it('gives the delegate the item and puts the original in params', async () => {
    // UC-INB-001 — the delegate holds `user_id`; the person they act for is a
    // badge, snapshotted so a later rename does not rewrite an acted-on task.
    await service.materialize('step-1');

    expect(inserted[0]!.params.delegateOfUserId).toBeUndefined();
    expect(inserted[1]!.params).toMatchObject({
      delegateOfUserId: 'user-b',
      delegateOfName: 'Sari Wijaya',
    });
  });

  it('carries the source ref, the deadline and a reference deep link', async () => {
    await service.materialize('step-1');

    expect(inserted[0]!.sourceRef).toEqual({
      instanceId: 'instance-1',
      stepId: 'step-1',
      assigneeId: 'seat-1',
      requestType: 'leave.request',
      requestId: 'request-1',
    });
    expect(inserted[0]!.dueAt).toEqual(new Date('2026-03-11T02:00:00Z'));
    // No route grammar exists in the handbook; the link is the two ids
    // `source_ref` already fixes, and nothing mobile has to agree with first.
    expect(inserted[0]!.deepLink).toBe('leave.request/request-1');
  });

  it('drops non-scalar context fields rather than storing [object Object]', async () => {
    await service.materialize('step-1');
    expect(inserted[0]!.params.nested).toBeUndefined();
    expect(inserted[0]!.params.dayCount).toBe(3);
  });

  it('writes nothing for a stuck step with no assignees', async () => {
    // BR-APRV-006 — the step is `active` with zero seats and the engine has
    // already flagged the instance. There is nobody to give a task to.
    step = { ...STEP, tasks: [] };
    await service.materialize('step-1');
    expect(inserted).toHaveLength(0);
  });

  it('writes nothing when the step is gone', async () => {
    step = null;
    expect(await service.materialize('step-1')).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it('completes the actor’s own seat', async () => {
    await service.completeActor('user-a', 'seat-1', new Date());
    expect(completed).toEqual([{ userId: 'user-a', dedupeKey: 'seat-1' }]);
  });

  it('closes siblings of one step as superseded', async () => {
    // BR-INB-006 — the `any`-quorum losers. Scoped to the step, because an
    // `all`-quorum step's other assignees are still genuinely actionable.
    await service.closeSiblings('instance-1', 'step-1');
    expect(closed).toEqual([{ instanceId: 'instance-1', stepId: 'step-1', reason: 'superseded' }]);
  });

  it.each([
    ['approved', 'instance_approved'],
    ['rejected', 'instance_rejected'],
    ['returned', 'instance_returned'],
    ['cancelled', 'instance_cancelled'],
  ] as const)('closes every open item on instance %s', async (outcome, reason) => {
    await service.closeInstance('instance-1', outcome);
    expect(closed).toEqual([{ instanceId: 'instance-1', stepId: null, reason }]);
  });
});
