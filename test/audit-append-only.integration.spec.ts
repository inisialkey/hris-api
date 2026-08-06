import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * BR-AUD-001 is a **grant**, not a convention, and a grant is only true in a
 * database — audit-log.md §14 asks for exactly this test. The module has no
 * update or delete method anywhere in it, so nothing in the unit suite can tell
 * you whether the guarantee survives someone adding one.
 *
 * `init-roles.sql` hands `hris_app` all four DML verbs by default privilege, so
 * the two that rewrite history are taken back in the audit migration. If that
 * revoke is ever dropped, these assertions are what notice.
 */
describe('audit log is append-only', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  let t1RowId: string;

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'audit-tenant-one'],
      [t2, 'audit-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
      // Identically shaped data in both tenants, so an isolation bug cannot hide
      // behind an asymmetry in the fixtures (testing-strategy §5.1).
      const rowId = await withTenant(tenantId, async (client) => {
        const id = uuidv7();
        await client.query(
          `INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type, metadata)
           VALUES ($1, $2, 'user', 'audit.log.queried', 'audit_log', $3)`,
          [id, tenantId, JSON.stringify({ filters: {} })],
        );
        return id;
      });
      if (tenantId === t1) t1RowId = rowId;
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  async function withTenant<T>(
    tenantId: string,
    fn: (client: import('pg').PoolClient) => Promise<T>,
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

  /**
   * A failed statement poisons its transaction, and every later statement in it
   * reports an aborted-transaction error rather than the permission error under
   * test. One fresh transaction per assertion — asserting on the wrong error is
   * how a grant test passes vacuously.
   */
  async function expectRefused(tenantId: string, sql: string, params: unknown[]): Promise<void> {
    await expect(withTenant(tenantId, (client) => client.query(sql, params))).rejects.toThrow(
      /permission denied/i,
    );
  }

  it('accepts appends', async () => {
    const rows = await withTenant(
      t1,
      async (c) => (await c.query<{ id: string }>('SELECT id FROM audit_logs')).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(t1RowId);
  });

  it('refuses UPDATE on audit_logs', async () => {
    // Corrections are new rows (BR-AUD-001). Rewriting one is how a trail stops
    // being evidence.
    await expectRefused(t1, 'UPDATE audit_logs SET action = $1 WHERE id = $2', [
      'nothing.happened',
      t1RowId,
    ]);
  });

  it('refuses DELETE on audit_logs', async () => {
    await expectRefused(t1, 'DELETE FROM audit_logs WHERE id = $1', [t1RowId]);
  });

  it('refuses UPDATE and DELETE on audit_anchors', async () => {
    // The anchor is the witness. An app that can rewrite it can certify the log
    // it just rewrote.
    await withTenant(t1, (client) =>
      client.query(
        `INSERT INTO audit_anchors (id, tenant_id, day, row_count, digest)
         VALUES ($1, $2, '2026-08-05', 1, 'deadbeef')`,
        [uuidv7(), t1],
      ),
    );
    await expectRefused(t1, 'UPDATE audit_anchors SET digest = $1 WHERE tenant_id = $2', [
      'forged',
      t1,
    ]);
    await expectRefused(t1, 'DELETE FROM audit_anchors WHERE tenant_id = $1', [t1]);
  });

  it('accepts one row per event and refuses the redelivery', async () => {
    // BR-AUD-003's dedup, worth proving now rather than when channel 2 arrives:
    // the handler will lean on `uq_audit_logs_event` to make redelivery a no-op,
    // and nothing else in this repository exercises that index.
    const eventId = uuidv7();
    const append = (id: string, event: string | null) =>
      withTenant(t1, (client) =>
        client.query(
          `INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type, event_id)
           VALUES ($1, $2, 'system', 'auth.session.revoked', 'sessions', $3)`,
          [id, t1, event],
        ),
      );

    await append(uuidv7(), eventId);
    await expect(append(uuidv7(), eventId)).rejects.toThrow(/uq_audit_logs_event/);

    // Channel-1 and sensitive-read rows carry no event id, and they are the bulk
    // of the table. PostgreSQL treats NULLs as distinct, so these coexist under
    // the constraint either way — what `WHERE event_id IS NOT NULL` buys is that
    // they are not in the index at all, which is why it is written that way.
    await append(uuidv7(), null);
    await append(uuidv7(), null);
  });

  it('pages a same-millisecond keyset without skipping or repeating', async () => {
    // §9: `occurred_at` is the DB clock and ties are broken by the uuidv7 id.
    // Three rows sharing one timestamp is the case the row-value comparison
    // exists for — an `occurred_at`-only cursor silently drops two of them.
    const instant = '2026-08-05T12:00:00.000Z';
    const ids = [uuidv7(), uuidv7(), uuidv7()].sort();
    for (const id of ids) {
      await withTenant(t1, (client) =>
        client.query(
          `INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, action, entity_type)
           VALUES ($1, $2, $3, 'user', 'keyset.probe', 'probe')`,
          [id, t1, instant],
        ),
      );
    }

    const page = (after?: { occurredAt: string; id: string }) =>
      withTenant(
        t1,
        async (client) =>
          (
            await client.query<{ id: string; occurred_at: Date }>(
              `SELECT id, occurred_at FROM audit_logs
               WHERE action = 'keyset.probe'
                 ${after ? 'AND (occurred_at, id) < ($1::timestamptz, $2::uuid)' : ''}
               ORDER BY occurred_at DESC, id DESC
               LIMIT 1`,
              after ? [after.occurredAt, after.id] : [],
            )
          ).rows,
      );

    const seen: string[] = [];
    let cursor: { occurredAt: string; id: string } | undefined;
    for (let i = 0; i < 3; i += 1) {
      const rows = await page(cursor);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('unreachable');
      seen.push(row.id);
      cursor = { occurredAt: row.occurred_at.toISOString(), id: row.id };
    }

    // Newest first, every row exactly once, and the feed is exhausted after them.
    expect(seen).toEqual([...ids].reverse());
    expect(await page(cursor)).toHaveLength(0);
  });

  it('scopes the log to one tenant', async () => {
    // No tenant predicate in the SQL — the omission is the assertion.
    const rows = await withTenant(
      t2,
      async (c) => (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM audit_logs')).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(t2);
  });

  it('refuses an append smuggling another tenant id', async () => {
    await expect(
      withTenant(t1, (client) =>
        client.query(
          `INSERT INTO audit_logs (id, tenant_id, actor_type, action, entity_type)
           VALUES ($1, $2, 'user', 'smuggled', 'audit_log')`,
          [uuidv7(), t2],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
