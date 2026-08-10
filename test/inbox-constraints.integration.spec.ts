import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * `inbox_items`' database rules — the assertions no unit test can make.
 *
 * A dedupe *decision* is a fake returning zero on command; the dedupe itself is
 * a unique index, and BR-INB-004's whole idempotency story rests on it holding
 * under a race no test can stage in TypeScript. Likewise §4's stated invariant
 * about the terminal stamps, which is a CHECK, and RLS, which is not a property
 * of a repository.
 */
describe('inbox constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const u1 = uuidv7();
  const u2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'inb-tenant-one'],
      [t2, 'inb-tenant-two'],
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
    await db.migrator.query('TRUNCATE inbox_items CASCADE');
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

  function insertItem(
    client: PoolClient,
    values: {
      tenantId: string;
      userId: string;
      dedupeKey: string;
      status?: string;
      doneAt?: string | null;
      closedReason?: string | null;
      sourceRef?: Record<string, string>;
    },
  ) {
    return client.query(
      `INSERT INTO inbox_items
         (id, tenant_id, user_id, type, status, dedupe_key, title, params, source_ref,
          deep_link, done_at, closed_reason)
       VALUES ($1, $2, $3, 'approval_task', $4, $5, 'Task', '{}'::jsonb, $6::jsonb,
               'leave.request/x', $7, $8)`,
      [
        uuidv7(),
        values.tenantId,
        values.userId,
        values.status ?? 'open',
        values.dedupeKey,
        JSON.stringify(values.sourceRef ?? { instanceId: 'i1', stepId: 's1' }),
        values.doneAt ?? null,
        values.closedReason ?? null,
      ],
    );
  }

  it('refuses a second item for the same user and dedupe key', async () => {
    // BR-INB-004 — the index *is* the idempotency, so a redelivered
    // `on.approval.step.activated` no-ops on it rather than on a read.
    await withTenant(t1, async (client) => {
      await insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'seat-1' });
      await expect(
        insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'seat-1' }),
      ).rejects.toThrow(/uq_inbox_items_dedupe/);
    });
  });

  it('lets two users hold items with the same dedupe key', async () => {
    // The acknowledgment case: one announcement id, one item per recipient.
    const u1b = uuidv7();
    await withTenant(t1, async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'one-b@example.test', 'x', 'active')`,
        [u1b, t1],
      );
      await insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'announcement-1' });
      await insertItem(client, { tenantId: t1, userId: u1b, dedupeKey: 'announcement-1' });

      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*)::int AS n FROM inbox_items WHERE dedupe_key = 'announcement-1'",
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });
  });

  it('scopes the dedupe key to a tenant', async () => {
    await withTenant(t1, (client) =>
      insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'seat-1' }),
    );
    await withTenant(t2, (client) =>
      insertItem(client, { tenantId: t2, userId: u2, dedupeKey: 'seat-1' }),
    );

    const { rows } = await db.migrator.query<{ n: string }>(
      "SELECT count(*)::int AS n FROM inbox_items WHERE dedupe_key = 'seat-1'",
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('refuses an open item carrying a terminal stamp', async () => {
    // §4's invariant: `done_at`/`closed_reason` are mutually exclusive with each
    // other's status, and an `open` item carries neither.
    await withTenant(t1, async (client) => {
      await expect(
        insertItem(client, {
          tenantId: t1,
          userId: u1,
          dedupeKey: 'seat-1',
          doneAt: '2026-03-10T00:00:00Z',
        }),
      ).rejects.toThrow(/ck_inbox_items_terminal_stamps/);
    });
  });

  it('refuses a done item with no stamp and a done item with a reason', async () => {
    await withTenant(t1, async (client) => {
      await expect(
        insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'a', status: 'done' }),
      ).rejects.toThrow(/ck_inbox_items_terminal_stamps/);
    });
    await withTenant(t1, async (client) => {
      await expect(
        insertItem(client, {
          tenantId: t1,
          userId: u1,
          dedupeKey: 'b',
          status: 'done',
          doneAt: '2026-03-10T00:00:00Z',
          closedReason: 'superseded',
        }),
      ).rejects.toThrow(/ck_inbox_items_terminal_stamps/);
    });
  });

  it('refuses a closed item with no reason and a closed item with a done stamp', async () => {
    await withTenant(t1, async (client) => {
      await expect(
        insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'c', status: 'closed' }),
      ).rejects.toThrow(/ck_inbox_items_terminal_stamps/);
    });
    await withTenant(t1, async (client) => {
      await expect(
        insertItem(client, {
          tenantId: t1,
          userId: u1,
          dedupeKey: 'd',
          status: 'closed',
          closedReason: 'retracted',
          doneAt: '2026-03-10T00:00:00Z',
        }),
      ).rejects.toThrow(/ck_inbox_items_terminal_stamps/);
    });
  });

  it('accepts each status with its own stamp', async () => {
    await withTenant(t1, async (client) => {
      await insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'open' });
      await insertItem(client, {
        tenantId: t1,
        userId: u1,
        dedupeKey: 'done',
        status: 'done',
        doneAt: '2026-03-10T00:00:00Z',
      });
      await insertItem(client, {
        tenantId: t1,
        userId: u1,
        dedupeKey: 'closed',
        status: 'closed',
        closedReason: 'instance_cancelled',
      });

      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*)::int AS n FROM inbox_items',
      );
      expect(Number(rows[0]!.n)).toBe(3);
    });
  });

  it('hides another tenant’s items behind RLS', async () => {
    await withTenant(t1, (client) =>
      insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'seat-1' }),
    );

    const visible = await withTenant(t2, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*)::int AS n FROM inbox_items',
      );
      return Number(rows[0]!.n);
    });

    expect(visible).toBe(0);
  });

  it('refuses a write stamped with another tenant’s id', async () => {
    // The policy's `WITH CHECK` half. A repository bug that passed the wrong
    // tenant id would otherwise write a row nobody can read.
    await withTenant(t2, async (client) => {
      await expect(
        insertItem(client, { tenantId: t1, userId: u1, dedupeKey: 'seat-1' }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('finds open items by the source-ref keys the closure paths use', async () => {
    // UC-INB-002's two lookups, over `idx_inbox_items_source_open` (A-199). The
    // predicate reads jsonb, which database-conventions §1.8 forbids filtering
    // on and §4 nonetheless makes the contract; this is the assertion that the
    // extraction actually matches what materialization wrote.
    await withTenant(t1, async (client) => {
      await insertItem(client, {
        tenantId: t1,
        userId: u1,
        dedupeKey: 'seat-1',
        sourceRef: { instanceId: 'i1', stepId: 's1' },
      });
      await insertItem(client, {
        tenantId: t1,
        userId: u1,
        dedupeKey: 'seat-2',
        sourceRef: { instanceId: 'i1', stepId: 's2' },
      });

      const byStep = await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM inbox_items
         WHERE status = 'open' AND source_ref->>'instanceId' = 'i1' AND source_ref->>'stepId' = 's1'`,
      );
      const byInstance = await client.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM inbox_items
         WHERE status = 'open' AND source_ref->>'instanceId' = 'i1'`,
      );

      expect(Number(byStep.rows[0]!.n)).toBe(1);
      expect(Number(byInstance.rows[0]!.n)).toBe(2);
    });
  });

  it('carries the partial expression index the closure paths need', async () => {
    const { rows } = await db.migrator.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_inbox_items_source_open'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("WHERE (status = 'open'");
  });
});
