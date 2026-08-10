import type { ApprovalTasksService } from './approval-tasks.service';
import { InboxEventHandlers, type ConsumedEvent } from './event-handlers.service';

const NOW = new Date('2026-03-10T02:00:00Z');

function event(name: string, payload: Record<string, unknown>): ConsumedEvent {
  return { id: 'event-1', name, aggregateId: 'instance-1', payload };
}

describe('InboxEventHandlers (§12)', () => {
  let calls: string[];
  let handlers: InboxEventHandlers;

  beforeEach(() => {
    calls = [];
    const tasks = {
      materialize: (stepId: string) => {
        calls.push(`materialize:${stepId}`);
        return Promise.resolve(2);
      },
      completeActor: (userId: string, assigneeId: string) => {
        calls.push(`complete:${userId}:${assigneeId}`);
        return Promise.resolve(1);
      },
      closeSiblings: (instanceId: string, stepId: string) => {
        calls.push(`siblings:${instanceId}:${stepId}`);
        return Promise.resolve(1);
      },
      closeInstance: (instanceId: string, outcome: string) => {
        calls.push(`instance:${instanceId}:${outcome}`);
        return Promise.resolve(3);
      },
    } as unknown as ApprovalTasksService;

    handlers = new InboxEventHandlers(tasks, { now: () => NOW });
  });

  it('materializes on step activation', async () => {
    const report = await handlers.handle(
      event('approval.step.activated', {
        instanceId: 'instance-1',
        stepId: 'step-1',
        assigneeUserIds: ['user-a'],
      }),
    );

    expect(report).toEqual({ affected: 2 });
    expect(calls).toEqual(['materialize:step-1']);
  });

  it('completes the actor’s own item on assignee.acted', async () => {
    // BR-INB-006 — per recorded decision, so a partial `all`-quorum approver's
    // task completes immediately rather than at step end.
    await handlers.handle(
      event('approval.assignee.acted', {
        instanceId: 'instance-1',
        stepId: 'step-1',
        assigneeId: 'seat-1',
        actorUserId: 'user-a',
        action: 'approve',
      }),
    );

    expect(calls).toEqual(['complete:user-a:seat-1']);
  });

  it('closes only the step’s siblings on step.decided', async () => {
    await handlers.handle(
      event('approval.step.decided', {
        instanceId: 'instance-1',
        stepId: 'step-1',
        outcome: 'approved',
        actorUserId: 'user-a',
      }),
    );

    expect(calls).toEqual(['siblings:instance-1:step-1']);
  });

  it.each(['approved', 'rejected', 'returned', 'cancelled'])(
    'closes every remaining item on instance.%s',
    async (outcome) => {
      const report = await handlers.handle(
        event(`approval.instance.${outcome}`, {
          instanceId: 'instance-1',
          requestType: 'leave.request',
          requestId: 'request-1',
          requesterUserId: 'user-requester',
        }),
      );

      expect(report).toEqual({ affected: 3 });
      expect(calls).toEqual([`instance:instance-1:${outcome}`]);
    },
  );

  it('does nothing for an event this module never registered', async () => {
    // The relay dispatches one job per (event, subscriber); a name that is not
    // ours is not an error.
    expect(await handlers.handle(event('payroll.run.completed', {}))).toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([
    ['approval.step.activated', {}],
    ['approval.assignee.acted', { assigneeId: 'seat-1' }],
    ['approval.assignee.acted', { actorUserId: 'user-a' }],
    ['approval.step.decided', { instanceId: 'instance-1' }],
    ['approval.instance.approved', {}],
  ])('refuses %s with a missing field rather than acting on a guess', async (name, payload) => {
    // A payload missing a field its own contract declares is a producer defect.
    // Retrying cannot make it appear, so the handler reports and stops.
    expect(await handlers.handle(event(name, payload))).toBeNull();
    expect(calls).toEqual([]);
  });
});
