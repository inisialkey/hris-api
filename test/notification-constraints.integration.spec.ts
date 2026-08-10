import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The three tables' database rules — the assertions no unit test can make.
 *
 * A dedupe *decision* is a fake returning `null` on command; the dedupe itself
 * is a unique index, and BR-NTF-004's whole idempotency story rests on it
 * holding under a race no test can stage in TypeScript. Likewise the delivery
 * cascade, the preference table's composite key, and RLS, which is not a
 * property of a repository.
 */
describe('notification constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const u1 = uuidv7();
  const u2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'ntf-tenant-one'],
      [t2, 'ntf-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await withTenant(t1, (client) =>
      client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'one@example.test', 'x', 'active')`,
        [u1, t1],
      ),
    );
    await withTenant(t2, (client) =>
      client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'two@example.test', 'x', 'active')`,
        [u2, t2],
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query('TRUNCATE notifications, notification_preferences CASCADE');
  });

  async function withTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function insertNotification(
    client: PoolClient,
    over: { id?: string; tenantId?: string; userId?: string; dedupeKey?: string } = {},
  ) {
    const id = over.id ?? uuidv7();
    return client.query(
      `INSERT INTO notifications
         (id, tenant_id, user_id, template_key, dedupe_key, title, body, params)
       VALUES ($1, $2, $3, 'approval.step_activated', $4, 'T', 'B', '{}'::jsonb)`,
      [id, over.tenantId ?? t1, over.userId ?? u1, over.dedupeKey ?? 'evt-1'],
    );
  }

  function insertDelivery(
    client: PoolClient,
    notificationId: string,
    over: { channel?: string; status?: string; sentAt?: string | null } = {},
  ) {
    return client.query(
      `INSERT INTO notification_deliveries
         (id, tenant_id, notification_id, channel, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        uuidv7(),
        t1,
        notificationId,
        over.channel ?? 'in_app',
        over.status ?? 'pending',
        over.sentAt ?? null,
      ],
    );
  }

  it('refuses a second row for the same event and recipient', async () => {
    // BR-NTF-004 — this index, not a read-then-write, is what makes a relay
    // replay a no-op.
    await withTenant(t1, (client) => insertNotification(client));

    await expect(
      withTenant(t1, (client) => insertNotification(client, { dedupeKey: 'evt-1' })),
    ).rejects.toThrow(/uq_notifications_dedupe/);
  });

  it('allows the same event to reach a second recipient', async () => {
    const other = uuidv7();
    await withTenant(t1, async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'three@example.test', 'x', 'active')`,
        [other, t1],
      );
      await insertNotification(client, { dedupeKey: 'evt-1' });
      await insertNotification(client, { dedupeKey: 'evt-1', userId: other });
    });

    const rows = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications',
    );
    expect(rows.rows[0]!.n).toBe(2);
  });

  it('lets the same dedupe key exist in another tenant', async () => {
    // The unique leads with `tenant_id`, so two tenants processing their own
    // copy of an event name never collide.
    await withTenant(t1, (client) => insertNotification(client, { dedupeKey: 'shared' }));
    await withTenant(t2, (client) =>
      insertNotification(client, { dedupeKey: 'shared', tenantId: t2, userId: u2 }),
    );

    const rows = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications',
    );
    expect(rows.rows[0]!.n).toBe(2);
  });

  it('refuses two delivery rows for one channel of one notification', async () => {
    const id = uuidv7();
    await withTenant(t1, async (client) => {
      await insertNotification(client, { id });
      await insertDelivery(client, id, { channel: 'push' });
    });

    await expect(
      withTenant(t1, (client) => insertDelivery(client, id, { channel: 'push' })),
    ).rejects.toThrow(/uq_notification_deliveries_channel/);
  });

  it('refuses a sent delivery with no sent_at', async () => {
    // §4.1's `pending --> sent` is the transition that stamps the time, and the
    // writer that could break it — the dispatch job — is not in this repository
    // yet. The constraint is here before it.
    const id = uuidv7();
    await withTenant(t1, (client) => insertNotification(client, { id }));

    await expect(
      withTenant(t1, (client) => insertDelivery(client, id, { status: 'sent', sentAt: null })),
    ).rejects.toThrow(/ck_notification_deliveries_sent_at/);
  });

  it('lets a failed delivery have no sent_at, because nothing was sent', async () => {
    const id = uuidv7();
    await withTenant(t1, async (client) => {
      await insertNotification(client, { id });
      await insertDelivery(client, id, { status: 'failed', sentAt: null });
    });

    const rows = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification_deliveries',
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it('takes the delivery rows with the notification when it is purged', async () => {
    // BR-NTF-010 deletes rows *and* delivery records, and the `ON DELETE
    // CASCADE` is what makes the purge one statement rather than an ordering
    // the job has to get right.
    const id = uuidv7();
    await withTenant(t1, async (client) => {
      await insertNotification(client, { id });
      await insertDelivery(client, id, { channel: 'in_app', status: 'sent', sentAt: '2026-03-10' });
      await insertDelivery(client, id, { channel: 'push' });
    });

    await withTenant(t1, (client) => client.query('DELETE FROM notifications WHERE id = $1', [id]));

    const rows = await db.migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification_deliveries',
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it('refuses a second opt-out row for the same cell', async () => {
    await withTenant(t1, (client) =>
      client.query(
        `INSERT INTO notification_preferences (tenant_id, user_id, template_key, channel)
         VALUES ($1, $2, 'announcement.published', 'push')`,
        [t1, u1],
      ),
    );

    await expect(
      withTenant(t1, (client) =>
        client.query(
          `INSERT INTO notification_preferences (tenant_id, user_id, template_key, channel)
           VALUES ($1, $2, 'announcement.published', 'push')`,
          [t1, u1],
        ),
      ),
    ).rejects.toThrow(/notification_preferences_tenant_id_user_id_template_key_channel/);
  });

  it('hides another tenant’s notifications from a scoped read', async () => {
    // ADR-0002 layer 2, on a table whose repository does not extend the
    // tenant-scoped base — so the policy is the only thing standing here.
    await withTenant(t1, (client) => insertNotification(client, { dedupeKey: 'a' }));
    await withTenant(t2, (client) =>
      insertNotification(client, { dedupeKey: 'b', tenantId: t2, userId: u2 }),
    );

    const seen = await withTenant(t1, (client) =>
      client.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications'),
    );
    expect(seen.rows[0]!.n).toBe(1);
  });

  it('refuses a write that claims another tenant', async () => {
    // The policy's `WITH CHECK` half: a repository bug that stamped the wrong
    // tenant would be rejected rather than silently filed under it.
    await expect(
      withTenant(t1, (client) => insertNotification(client, { tenantId: t2, userId: u2 })),
    ).rejects.toThrow(/row-level security/);
  });

  it('hides another tenant’s preference rows', async () => {
    await withTenant(t2, (client) =>
      client.query(
        `INSERT INTO notification_preferences (tenant_id, user_id, template_key, channel)
         VALUES ($1, $2, 'announcement.published', 'push')`,
        [t2, u2],
      ),
    );

    const seen = await withTenant(t1, (client) =>
      client.query<{ n: number }>('SELECT count(*)::int AS n FROM notification_preferences'),
    );
    expect(seen.rows[0]!.n).toBe(0);
  });
});
