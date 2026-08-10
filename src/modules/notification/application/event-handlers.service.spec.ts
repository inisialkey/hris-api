import type { SendCommand, SendReport } from '../domain/notification.types';
import { NotificationEventHandlers, type ConsumedEvent } from './event-handlers.service';
import type { SendService } from './send.service';

const REPORT: SendReport = { created: 1, deduped: 0, suppressed: 0 };

describe('NotificationEventHandlers (UC-NTF-001, §12)', () => {
  let sent: SendCommand[];
  let handlers: NotificationEventHandlers;

  beforeEach(() => {
    sent = [];
    const sends = {
      send: (command: SendCommand) => {
        sent.push(command);
        return Promise.resolve(REPORT);
      },
    } as unknown as SendService;

    handlers = new NotificationEventHandlers(sends);
  });

  const event = (name: string, payload: Record<string, unknown>): ConsumedEvent => ({
    id: 'evt-1',
    name,
    aggregateId: 'agg-1',
    payload,
  });

  it('sends a step activation to the assignees the payload names', async () => {
    await handlers.handle(
      event('approval.step.activated', {
        instanceId: 'i-1',
        stepId: 's-1',
        assigneeUserIds: ['u-1', 'u-2'],
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.templateKey).toBe('approval.step_activated');
    expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: ['u-1', 'u-2'] });
  });

  it('sends an escalation to the escalation targets', async () => {
    await handlers.handle(
      event('approval.step.escalated', { escalatedToUserIds: ['m-1'], stepId: 's-1' }),
    );

    expect(sent[0]!.templateKey).toBe('approval.step_escalated');
    expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: ['m-1'] });
  });

  it.each(['approved', 'rejected', 'returned'])(
    'sends a decided instance to the requester (%s)',
    async (status) => {
      await handlers.handle(
        event(`approval.instance.${status}`, {
          instanceId: 'i-1',
          requestType: 'leave.request',
          requestId: 'r-1',
          requesterUserId: 'u-9',
        }),
      );

      expect(sent[0]!.templateKey).toBe('approval.instance_decided');
      expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: ['u-9'] });
    },
  );

  it('sends nothing when the requester cancelled their own request', async () => {
    // Consumed in §12 and mapped to nothing on purpose — telling somebody what
    // they just did is not a notification.
    const report = await handlers.handle(
      event('approval.instance.cancelled', { requesterUserId: 'u-9' }),
    );

    expect(report).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('uses the event id as the dedupe key so a redelivery collides', async () => {
    // BR-NTF-004 — the whole idempotency story for the event path is this line.
    await handlers.handle(event('auth.password.changed', { userId: 'u-1' }));

    expect(sent[0]!.dedupeKey).toBe('evt-1');
  });

  it('addresses a device revocation to the account owner, not to a device', async () => {
    // §4.2's *"remaining active devices"* is a push-target rule, and BR-NTF-007
    // applies it at dispatch — one row, for the person.
    await handlers.handle(event('auth.device.revoked', { deviceId: 'd-1', userId: 'u-1' }));

    expect(sent[0]!.templateKey).toBe('auth.device_revoked');
    expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: ['u-1'] });
  });

  it.each(['authz.assignment.granted', 'authz.assignment.revoked'])(
    'tells the affected user their access changed (%s)',
    async (name) => {
      await handlers.handle(event(name, { assignmentId: 'a-1', userId: 'u-3', roleId: 'r-1' }));

      expect(sent[0]!.templateKey).toBe('authz.access_changed');
      expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: ['u-3'] });
    },
  );

  it('passes scalar payload fields through as template variables', async () => {
    await handlers.handle(
      event('authz.assignment.granted', { userId: 'u-3', roleId: 'r-1', nested: { a: 1 } }),
    );

    // A nested object would be stored in the jsonb column and rendered as
    // `[object Object]`; the templates take scalars.
    expect(sent[0]!.params).toEqual({ userId: 'u-3', roleId: 'r-1' });
  });

  it('sends nothing, and does not throw, when the payload omits its recipient', async () => {
    const report = await handlers.handle(event('auth.password.changed', {}));

    expect(report).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('sends to nobody when a recipient list field is not a list', async () => {
    await handlers.handle(event('approval.step.activated', { assigneeUserIds: 'u-1' }));

    expect(sent[0]!.recipients).toEqual({ kind: 'users', userIds: [] });
  });

  it('ignores an event this module never registered', async () => {
    const report = await handlers.handle(event('payroll.run.closed', { runId: 'r-1' }));

    expect(report).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
