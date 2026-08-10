import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import type { RoleHolderPort } from '../src/modules/authz';
import { NotificationEventHandlers } from '../src/modules/notification/application/event-handlers.service';
import { FeedService } from '../src/modules/notification/application/feed.service';
import { NotificationJobsService } from '../src/modules/notification/application/notification-jobs.service';
import { NotificationStatsService } from '../src/modules/notification/application/notification-stats.service';
import { PreferenceService } from '../src/modules/notification/application/preference.service';
import { SendService } from '../src/modules/notification/application/send.service';
import { DeliveryRepository } from '../src/modules/notification/infrastructure/delivery.repository';
import { NotificationRepository } from '../src/modules/notification/infrastructure/notification.repository';
import { PreferenceRepository } from '../src/modules/notification/infrastructure/preference.repository';
import type { SettingsPort } from '../src/modules/settings';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The pipeline end to end against a real database.
 *
 * The unit suite proves each decision with fakes that answer on command. What
 * only a database proves is the part the fakes stand in for: that the dedupe is
 * an index rather than a policy, that the feed's population really is *"a
 * notification with a live in-app delivery"* — a semi-join no in-memory fake can
 * be wrong about — and that the purge deletes what is past the window and
 * nothing else, which testing-strategy §14.1 requires of every destructive cron
 * two-sided, because a purge with an inverted predicate is perfectly idempotent
 * and destroys everything.
 */
describe('notification lifecycle', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let db: TestDatabase;
  let unitOfWork: UnitOfWork;
  let sends: SendService;
  let feed: FeedService;
  let preferences: PreferenceService;
  let handlers: NotificationEventHandlers;
  let jobs: NotificationJobsService;
  let stats: NotificationStatsService;

  const tenantId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  let roleHolders: string[] = [];
  let retentionDays = 90;

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    const connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'ntf-lifecycle',
    ]);
    // Seeded on one connection with a session-level GUC: `users` is under RLS
    // and `db.app` is a pool where the next statement is a different connection.
    const client = await db.app.connect();
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    for (const [id, email] of [
      [userId, 'subject@example.test'],
      [otherUserId, 'other@example.test'],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, $3, 'x', 'active')`,
        [id, tenantId, email],
      );
    }
    client.release();

    const clock = { now: () => NOW };
    const settings = {
      resolve: <T>() => Promise.resolve(retentionDays as T),
    } as unknown as SettingsPort;
    const roles: RoleHolderPort = {
      findIdByKey: () => Promise.resolve('role-1'),
      holderUserIds: () => Promise.resolve(roleHolders),
      exists: () => Promise.resolve(true),
    };

    const notifications = new NotificationRepository(connection);
    const deliveries = new DeliveryRepository(connection);
    const preferenceRepository = new PreferenceRepository(connection);

    sends = new SendService(notifications, deliveries, preferenceRepository, roles, clock);
    feed = new FeedService(notifications, clock);
    preferences = new PreferenceService(preferenceRepository);
    handlers = new NotificationEventHandlers(sends);
    jobs = new NotificationJobsService(notifications, settings, clock);
    stats = new NotificationStatsService(deliveries);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    roleHolders = [];
    retentionDays = 90;
    await db.migrator.query('TRUNCATE notifications, notification_preferences CASCADE');
  });

  /**
   * One request-shaped unit of work. The tenant is set twice on purpose and it
   * is not redundant: `UnitOfWork.run` sets the database GUC that RLS reads,
   * while `setTenantContext` fills the AsyncLocalStorage the repositories stamp
   * writes from. In production those are two different layers of the guard
   * chain (backend-nestjs §5 positions 3 and 7).
   */
  const asUser = <T>(fn: () => Promise<T>, actor = userId): Promise<T> =>
    runInContextScope({}, () => {
      const tenant = { tenantId, source: 'jwt' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7(), userId: actor });
      return unitOfWork.run(tenant, fn);
    });

  /** A worker-shaped one: tenant, no actor. */
  const asJob = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      const tenant = { tenantId, source: 'job' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7() });
      return unitOfWork.run(tenant, fn);
    });

  it('lands a feed row and a delivery row per declared channel', async () => {
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [userId] },
        params: {},
        dedupeKey: 'evt-1',
      }),
    );

    const rows = await asUser(() => feed.list({ limit: 20, unreadOnly: false }));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.title).toBe('Menunggu persetujuan Anda');

    const channels = await db.migrator.query<{ channel: string; status: string }>(
      'SELECT channel, status FROM notification_deliveries ORDER BY channel',
    );
    expect(channels.rows).toEqual([
      { channel: 'in_app', status: 'sent' },
      { channel: 'push', status: 'pending' },
    ]);
  });

  it('is idempotent across a redelivered handler job', async () => {
    // BR-NTF-004 against the real index, in two separate transactions — the
    // shape a relay redispatch actually takes.
    const event = {
      id: 'evt-42',
      name: 'approval.step.activated',
      aggregateId: 'i-1',
      payload: { assigneeUserIds: [userId] },
    };

    await asJob(() => handlers.handle(event));
    const second = await asJob(() => handlers.handle(event));

    expect(second).toEqual({ created: 0, deduped: 1, suppressed: 0 });
    const rows = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications',
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('keeps an email-only notification out of the feed', async () => {
    // BR-NTF-008 — the row is written because it is the parent of its
    // deliveries; a password-reset email is not feed traffic.
    await asJob(() =>
      sends.send({
        templateKey: 'auth.password_changed',
        recipients: { kind: 'users', userIds: [userId] },
        params: {},
        dedupeKey: 'evt-2',
      }),
    );

    const stored = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications',
    );
    expect(stored.rows[0]!.n).toBe(1);

    const rows = await asUser(() => feed.list({ limit: 20, unreadOnly: false }));
    expect(rows.rows).toHaveLength(0);
    await expect(asUser(() => feed.unreadCount())).resolves.toBe(0);
  });

  it('keeps a suppressed in-app channel out of the feed', async () => {
    // BR-NTF-005 through to its visible consequence: the delivery records the
    // suppression and the feed honours it, rather than showing a row the user
    // asked not to be told about.
    await asUser(() => preferences.toggle('announcement.published', 'in_app', false));

    await asJob(() =>
      sends.send({
        templateKey: 'announcement.published',
        recipients: { kind: 'users', userIds: [userId] },
        params: { announcementTitle: 'Kantin tutup Jumat' },
        dedupeKey: 'ann-1',
      }),
    );

    const rows = await asUser(() => feed.list({ limit: 20, unreadOnly: false }));
    expect(rows.rows).toHaveLength(0);

    const delivery = await db.migrator.query<{ status: string }>(
      "SELECT status FROM notification_deliveries WHERE channel = 'in_app'",
    );
    expect(delivery.rows[0]!.status).toBe('skipped');
  });

  it('shows one user’s feed to that user only', async () => {
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [otherUserId] },
        params: {},
        dedupeKey: 'evt-3',
      }),
    );

    await expect(asUser(() => feed.list({ limit: 20, unreadOnly: false }))).resolves.toEqual({
      rows: [],
      hasMore: false,
    });
  });

  it('counts, marks and stops counting', async () => {
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [userId] },
        params: {},
        dedupeKey: 'evt-4',
      }),
    );

    const before = await asUser(() => feed.unreadCount());
    const listed = await asUser(() => feed.list({ limit: 20, unreadOnly: true }));
    const marked = await asUser(() => feed.markRead(listed.rows[0]!.id));
    const after = await asUser(() => feed.unreadCount());

    expect(before).toBe(1);
    expect(marked.ok).toBe(true);
    expect(after).toBe(0);
  });

  it('answers 404 for another user’s row rather than marking it', async () => {
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [otherUserId] },
        params: {},
        dedupeKey: 'evt-5',
      }),
    );
    const rows = await db.migrator.query<{ id: string }>('SELECT id FROM notifications');

    const result = await asUser(() => feed.markRead(rows.rows[0]!.id));

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    const stamped = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE read_at IS NOT NULL',
    );
    expect(stamped.rows[0]!.n).toBe(0);
  });

  it('resolves a role audience through the authz port', async () => {
    roleHolders = [userId, otherUserId];

    const report = await asJob(() =>
      sends.send({
        templateKey: 'approval.instance_stuck',
        recipients: { kind: 'role', roleKey: 'hr_admin', companyId: uuidv7() },
        params: {},
        dedupeKey: 'stuck-1',
      }),
    );

    expect(report.created).toBe(2);
  });

  it('purges past the window, keeps what is inside it, and leaves preferences alone', async () => {
    // testing-strategy §14.1's two-sided rule for a destructive cron.
    await asUser(() => preferences.toggle('announcement.published', 'push', false));
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [userId, otherUserId] },
        params: {},
        dedupeKey: 'evt-6',
      }),
    );

    // One row aged past the window, one left inside it. `created_at` defaults to
    // the server clock, so the age is applied afterwards rather than sent in.
    await db.migrator.query(`UPDATE notifications SET created_at = $1 WHERE user_id = $2`, [
      new Date('2025-01-01T00:00:00Z'),
      userId,
    ]);

    const report = await asJob(() => jobs.purge());

    expect(report).toEqual({ purged: 1 });
    const left = await db.migrator.query<{ user_id: string }>('SELECT user_id FROM notifications');
    expect(left.rows.map((row) => row.user_id)).toEqual([otherUserId]);

    const kept = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification_preferences',
    );
    expect(kept.rows[0]!.n).toBe(1);
  });

  it('counts failed deliveries for the platform-health page', async () => {
    await asJob(() =>
      sends.send({
        templateKey: 'approval.step_activated',
        recipients: { kind: 'users', userIds: [userId] },
        params: {},
        dedupeKey: 'evt-7',
      }),
    );
    await db.migrator.query(
      "UPDATE notification_deliveries SET status = 'failed' WHERE channel = 'push'",
    );

    await expect(
      asJob(() => stats.failedDeliveryCount(new Date('2026-01-01T00:00:00Z'))),
    ).resolves.toBe(1);
  });

  it('pages the feed by cursor without repeating or skipping a row', async () => {
    for (let index = 0; index < 5; index += 1) {
      await asJob(() =>
        sends.send({
          templateKey: 'approval.step_activated',
          recipients: { kind: 'users', userIds: [userId] },
          params: {},
          dedupeKey: `page-${index}`,
        }),
      );
    }

    const first = await asUser(() => feed.list({ limit: 3, unreadOnly: false }));
    const last = first.rows.at(-1)!;
    const second = await asUser(() =>
      feed.list({
        limit: 3,
        unreadOnly: false,
        after: { createdAt: last.createdAt, id: last.id },
      }),
    );

    expect(first.rows).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.rows, ...second.rows].map((row) => row.id)).size).toBe(5);
  });
});
