import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The multi-tenancy §5 leak matrix, against the walking skeleton's throwaway
 * table (implementation-roadmap §4.1 item 2).
 *
 * L1–L3 and L7 are the four rows the skeleton can answer today; L4, L5, L6, L8
 * and L9 need a repository base class, company scope, a job wrapper, and a
 * platform session, none of which exist yet. They arrive with the platform
 * spine, and this file becomes `describeTenantIsolation`'s first caller when
 * testing-strategy §5.1's kit is built.
 *
 * The kit's own rule is honoured here: both tenants get **identically shaped**
 * data, so an isolation bug cannot hide behind an asymmetry in the fixtures.
 */
describe('tenant isolation (leak matrix)', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'tenant-one'],
      [t2, 'tenant-two'],
    ] as const) {
      // `tenants` is a platform table with no RLS.
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
      await withTenant(tenantId, async (client) => {
        await client.query('INSERT INTO scratch_notes (id, tenant_id, body) VALUES ($1, $2, $3)', [
          uuidv7(),
          tenantId,
          `note for ${slug}`,
        ]);
      });
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  /** The UnitOfWork shape: transaction, `set_config` first, work, commit. */
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

  it('L1 — a query under T1 sees only T1 rows', async () => {
    const rows = await withTenant(
      t1,
      async (c) =>
        // No tenant predicate in the SQL. That omission is the assertion.
        (await c.query<{ tenant_id: string }>('SELECT tenant_id FROM scratch_notes')).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(t1);
  });

  it('L2 — the same query with no set_config returns zero rows', async () => {
    // Layer 2 in isolation: application scoping removed entirely, RLS alone.
    // `current_setting('app.tenant_id', true)` is NULL, the policy evaluates
    // false, and the default is deny rather than "everything".
    const { rows } = await db.app.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM scratch_notes',
    );
    expect(rows).toHaveLength(0);
  });

  it('L3 — a write smuggling another tenant id is rejected', async () => {
    await expect(
      withTenant(t1, async (c) =>
        c.query('INSERT INTO scratch_notes (id, tenant_id, body) VALUES ($1, $2, $3)', [
          uuidv7(),
          t2,
          'smuggled',
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);

    // And nothing landed.
    const rows = await withTenant(
      t2,
      async (c) => (await c.query<{ id: string }>('SELECT id FROM scratch_notes')).rows,
    );
    expect(rows).toHaveLength(1);
  });

  it('L7 — hris_auth reads its four tables and writes nothing', async () => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE hris_auth');

      // Reads the four lookup tables with no tenant context — that is the point
      // of the role, since login runs before a tenant is known.
      await expect(client.query('SELECT id FROM users')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM sessions')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM devices')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM auth_tokens')).resolves.toBeDefined();

      // A fifth tenant table is not reachable.
      await expect(client.query('SELECT id FROM scratch_notes')).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Writes nothing, in a fresh transaction — the failures above poisoned the
    // previous one, and a rolled-back transaction reports every later statement
    // as an aborted-transaction error rather than as the permission error under
    // test. Asserting on the wrong error is how a leak test passes vacuously.
    const writer = await db.app.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SET LOCAL ROLE hris_auth');
      await expect(
        writer.query('UPDATE users SET email = $1 WHERE true', ['x@y.test']),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
});
