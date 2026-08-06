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
