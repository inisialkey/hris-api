import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { RoleHolderPort } from '../../authz';
import type {
  DeliveryRepositoryPort,
  NewDelivery,
  NewNotification,
  NotificationRepositoryPort,
  PreferenceRepositoryPort,
} from '../domain/notification.ports';
import type { NotificationChannel, NotificationRow } from '../domain/notification.types';
import { FANOUT_CHUNK, SendService } from './send.service';

const TENANT = '01931b7c-0000-7000-8000-0000000000t1';
const NOW = new Date('2026-03-10T02:00:00Z');

describe('SendService (UC-NTF-001/002/006)', () => {
  let rows: NotificationRow[];
  let deliveries: NewDelivery[];
  let optOuts: Map<string, Set<NotificationChannel>>;
  let roleHolders: string[];
  let roleId: string | null;
  let preferenceReads: { userIds: readonly string[]; templateKey: string }[];
  let sends: SendService;

  beforeEach(() => {
    rows = [];
    deliveries = [];
    optOuts = new Map();
    roleHolders = [];
    roleId = 'role-1';
    preferenceReads = [];

    const notifications: NotificationRepositoryPort = {
      insertIfNew: (notification: NewNotification) => {
        const clash = rows.some(
          (row) => row.dedupeKey === notification.dedupeKey && row.userId === notification.userId,
        );
        if (clash) return Promise.resolve(null);

        const row: NotificationRow = {
          id: `n-${rows.length + 1}`,
          userId: notification.userId,
          templateKey: notification.templateKey,
          dedupeKey: notification.dedupeKey,
          title: notification.title,
          body: notification.body,
          params: notification.params,
          deepLink: notification.deepLink ?? null,
          readAt: null,
          createdAt: NOW,
        };
        rows.push(row);
        return Promise.resolve(row);
      },
      findById: () => Promise.resolve(null),
      feed: () => Promise.resolve({ rows: [], hasMore: false }),
      unreadCount: () => Promise.resolve(0),
      markRead: () => Promise.resolve(null),
      markAllRead: () => Promise.resolve(0),
      deleteCreatedBefore: () => Promise.resolve(0),
    };

    const deliveryRepository: DeliveryRepositoryPort = {
      createMany: (created) => {
        deliveries.push(...created);
        return Promise.resolve();
      },
      listFor: () => Promise.resolve([]),
      countFailedSince: () => Promise.resolve(0),
    };

    const preferences: PreferenceRepositoryPort = {
      listForUser: () => Promise.resolve([]),
      optedOutChannels: (userIds, templateKey) => {
        preferenceReads.push({ userIds, templateKey });
        return Promise.resolve(optOuts);
      },
      optOut: () => Promise.resolve(),
      optIn: () => Promise.resolve(),
    };

    const roles: RoleHolderPort = {
      findIdByKey: () => Promise.resolve(roleId),
      holderUserIds: () => Promise.resolve(roleHolders),
      exists: () => Promise.resolve(true),
    };

    sends = new SendService(notifications, deliveryRepository, preferences, roles, {
      now: () => NOW,
    });
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: TENANT, source: 'job' });
      return fn();
    });

  const channelsOf = (notificationId: string) =>
    deliveries.filter((row) => row.notificationId === notificationId);

  it('writes one row per recipient with the rendered snapshot', async () => {
    const report = await run(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: ['u-1', 'u-2'] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(report).toEqual({ created: 2, deduped: 0, suppressed: 0 });
    expect(rows.map((row) => row.userId)).toEqual(['u-1', 'u-2']);
    // BR-NTF-006 — the snapshot is stored, not the key.
    expect(rows[0]!.title).toBe('Menunggu persetujuan Anda');
  });

  it('records in_app as sent and push as pending', async () => {
    // UC-NTF-003: `in_app` is `sent` at row creation; push waits for a provider.
    await run(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: ['u-1'] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(channelsOf('n-1')).toEqual([
      { notificationId: 'n-1', channel: 'in_app', status: 'sent', sentAt: NOW },
      { notificationId: 'n-1', channel: 'push', status: 'pending' },
    ]);
  });

  it('creates a delivery row for every declared channel and no others', async () => {
    await run(() =>
      sends.send({
        templateKey: 'approval.step_escalated',
        recipients: { kind: 'users', userIds: ['u-1'] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(channelsOf('n-1').map((row) => row.channel)).toEqual(['in_app', 'push', 'email']);
  });

  it('skips a redelivered event instead of writing a second row', async () => {
    // BR-NTF-004 — the dedupe index answers, and a relay replay is a no-op.
    const command = {
      templateKey: 'approval.step_activated',
      recipients: { kind: 'users' as const, userIds: ['u-1'] },
      params: {},
      dedupeKey: 'event-1',
    };
    await run(() => sends.send(command));
    const second = await run(() => sends.send(command));

    expect(second).toEqual({ created: 0, deduped: 1, suppressed: 0 });
    expect(rows).toHaveLength(1);
    expect(deliveries).toHaveLength(2);
  });

  it('dedupes repeated recipients inside one send', async () => {
    const report = await run(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: ['u-1', 'u-1'] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(report.created).toBe(1);
    expect(report.deduped).toBe(0);
  });

  it('suppresses an opted-out channel on an optional template', async () => {
    // BR-NTF-005 — the row still lands; the channel records why it did not go.
    optOuts.set('u-1', new Set<NotificationChannel>(['push']));

    const report = await run(() =>
      sends.send({
        templateKey: 'announcement.published',
        recipients: { kind: 'users', userIds: ['u-1'] },
        params: { announcementTitle: 'Kantin tutup Jumat' },
        dedupeKey: 'ann-1',
      }),
    );

    expect(report.suppressed).toBe(1);
    expect(channelsOf('n-1')).toEqual([
      { notificationId: 'n-1', channel: 'in_app', status: 'sent', sentAt: NOW },
      { notificationId: 'n-1', channel: 'push', status: 'skipped' },
    ]);
  });

  it('ignores preferences entirely for a mandatory template', async () => {
    // BR-NTF-005 — *"preferences suppress optional templates only"*. The stored
    // rows are not consulted, so a row that arrived some other way cannot
    // silence a security notice.
    optOuts.set('u-1', new Set<NotificationChannel>(['in_app', 'push']));

    const report = await run(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: ['u-1'] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(report.suppressed).toBe(0);
    expect(preferenceReads).toHaveLength(0);
    expect(channelsOf('n-1').every((row) => row.status !== 'skipped')).toBe(true);
  });

  it('reads preferences once for the whole chunk, not once per recipient', async () => {
    await run(() =>
      sends.send({
        templateKey: 'announcement.published',
        recipients: { kind: 'users', userIds: ['u-1', 'u-2', 'u-3'] },
        params: { announcementTitle: 'x' },
        dedupeKey: 'ann-1',
      }),
    );

    expect(preferenceReads).toHaveLength(1);
    expect(preferenceReads[0]!.userIds).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('resolves a role audience at send time', async () => {
    // §9 — membership is evaluated when the job runs, not when the cause
    // occurred: a just-granted admin gets it, a just-revoked one does not.
    roleHolders = ['admin-1', 'admin-2'];

    const report = await run(() =>
      sends.send({
        templateKey: 'approval.instance_stuck',
        recipients: { kind: 'role', roleKey: 'hr_admin', companyId: 'c-1' },
        params: {},
        dedupeKey: 'stuck-1',
      }),
    );

    expect(report.created).toBe(2);
    expect(rows.map((row) => row.userId)).toEqual(['admin-1', 'admin-2']);
  });

  it('sends to nobody when the tenant has no live role for the key', async () => {
    roleId = null;

    const report = await run(() =>
      sends.send({
        templateKey: 'approval.instance_stuck',
        recipients: { kind: 'role', roleKey: 'hr_admin', companyId: 'c-1' },
        params: {},
        dedupeKey: 'stuck-1',
      }),
    );

    expect(report).toEqual({ created: 0, deduped: 0, suppressed: 0 });
    expect(rows).toHaveLength(0);
  });

  it('chunks a fan-out at 500 and stays idempotent across a re-run', async () => {
    // BR-NTF-009. The chunk boundary is invisible in the result — what proves it
    // is the preference read count, which is one query per chunk.
    const userIds = Array.from({ length: 1_200 }, (_, index) => `u-${index}`);
    const command = {
      templateKey: 'announcement.published',
      userIds,
      params: { announcementTitle: 'Libur bersama' },
      dedupeKey: 'ann-42',
    };

    const first = await run(() => sends.fanout(command));
    const chunks = [...preferenceReads];
    const second = await run(() => sends.fanout(command));

    expect(first.created).toBe(1_200);
    expect(chunks).toHaveLength(Math.ceil(1_200 / FANOUT_CHUNK));
    expect(chunks.every((read) => read.userIds.length <= FANOUT_CHUNK)).toBe(true);
    expect(second).toEqual({ created: 0, deduped: 1_200, suppressed: 0 });
    expect(rows).toHaveLength(1_200);
  });

  it('throws on a template the registry does not carry', async () => {
    // A caller defect, not a user-facing condition — the reason
    // `SettingsPort.resolve` throws on an unknown key.
    await expect(
      run(() =>
        sends.send({
          templateKey: 'payroll.made_up',
          recipients: { kind: 'users', userIds: ['u-1'] },
          params: {},
          dedupeKey: 'x',
        }),
      ),
    ).rejects.toThrow(/unregistered notification template/);
  });

  it('writes nothing when the recipient list is empty', async () => {
    const report = await run(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [] },
        params: {},
        dedupeKey: 'event-1',
      }),
    );

    expect(report).toEqual({ created: 0, deduped: 0, suppressed: 0 });
    expect(preferenceReads).toHaveLength(0);
  });

  it('stores the caller’s deep link when one is supplied', async () => {
    await run(() =>
      sends.send({
        templateKey: 'announcement.published',
        recipients: { kind: 'users', userIds: ['u-1'] },
        params: { announcementTitle: 'x' },
        dedupeKey: 'ann-1',
        deepLink: '/announcements/a-1',
      }),
    );

    expect(rows[0]!.deepLink).toBe('/announcements/a-1');
  });
});
