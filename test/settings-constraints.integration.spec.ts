import { uuidv7 } from 'uuidv7';

import { syncDefinitions } from '../src/database/sync-definitions';
import { SETTING_DEFINITIONS } from '../src/modules/settings/domain/definitions';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * settings.md §14's database rows. Every assertion here is about something the
 * unit suite structurally cannot see: `plan-write.ts` decides where a row goes,
 * but *nothing stops two requests deciding at once* except the exclusion
 * constraint, and a constraint is only true in a database.
 */
describe('setting value constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'settings-tenant-one'],
      [t2, 'settings-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }
    await withTenant(t1, (client) =>
      client.query('INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [
        c1,
        t1,
        'C1',
        'Company One',
      ]),
    );
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

  function insert(
    client: import('pg').PoolClient,
    over: {
      tenantId: string;
      key: string;
      level?: string;
      companyId?: string | null;
      branchId?: string | null;
      from: string;
      to?: string | null;
    },
  ) {
    return client.query(
      `INSERT INTO setting_values (id, tenant_id, key, level, company_id, branch_id, value, effective_from, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uuidv7(),
        over.tenantId,
        over.key,
        over.level ?? 'tenant',
        over.companyId ?? null,
        over.branchId ?? null,
        JSON.stringify(30),
        over.from,
        over.to ?? null,
      ],
    );
  }

  describe('scope consistency (§4.1 CHECK)', () => {
    it('refuses a company row with no company id', async () => {
      await expect(
        withTenant(t1, (client) =>
          insert(client, {
            tenantId: t1,
            key: 'chk.company',
            level: 'company',
            from: '2026-01-01',
          }),
        ),
      ).rejects.toThrow(/chk_setting_values_scope/);
    });

    it('refuses a branch row with no company id', async () => {
      // Resolution walks branch → company → tenant. A branch row with no company
      // has no chain to sit in, and the row would simply never be found.
      await expect(
        withTenant(t1, (client) =>
          insert(client, {
            tenantId: t1,
            key: 'chk.branch',
            level: 'branch',
            branchId: uuidv7(),
            from: '2026-01-01',
          }),
        ),
      ).rejects.toThrow(/chk_setting_values_scope/);
    });

    it('refuses a tenant row that carries a company id', async () => {
      await expect(
        withTenant(t1, (client) =>
          insert(client, {
            tenantId: t1,
            key: 'chk.tenant',
            level: 'tenant',
            companyId: c1,
            from: '2026-01-01',
          }),
        ),
      ).rejects.toThrow(/chk_setting_values_scope/);
    });

    it('accepts a company row with its company id', async () => {
      await expect(
        withTenant(t1, (client) =>
          insert(client, {
            tenantId: t1,
            key: 'chk.ok',
            level: 'company',
            companyId: c1,
            from: '2026-01-01',
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('no overlapping intervals (BR-SET-003)', () => {
    it('refuses a second open-ended row for the same key and scope', async () => {
      await withTenant(t1, (client) =>
        insert(client, { tenantId: t1, key: 'excl.same', from: '2026-01-01' }),
      );
      await expect(
        withTenant(t1, (client) =>
          insert(client, { tenantId: t1, key: 'excl.same', from: '2026-06-01' }),
        ),
      ).rejects.toThrow(/excl_setting_values_no_overlap/);
    });

    it('accepts adjacent intervals that share a boundary', async () => {
      // `[)` — the boundary date belongs to the successor, so history is
      // contiguous with no gap and no overlap (database-conventions §5 rule 1).
      await withTenant(t1, async (client) => {
        await insert(client, {
          tenantId: t1,
          key: 'excl.adjacent',
          from: '2026-01-01',
          to: '2026-06-01',
        });
        await insert(client, { tenantId: t1, key: 'excl.adjacent', from: '2026-06-01' });
      });
    });

    it('lets two tenant-level rows for one key coexist across tenants', async () => {
      // The COALESCE in the constraint is what makes this work: `NULL = NULL` is
      // not true under `WITH =`, so without it two tenant rows would never
      // conflict *and* two rows in one tenant would not either.
      await withTenant(t1, (client) =>
        insert(client, { tenantId: t1, key: 'excl.per-tenant', from: '2026-01-01' }),
      );
      await expect(
        withTenant(t2, (client) =>
          insert(client, { tenantId: t2, key: 'excl.per-tenant', from: '2026-01-01' }),
        ),
      ).resolves.toBeDefined();
    });

    it('separates the same key at tenant and company level', async () => {
      await withTenant(t1, async (client) => {
        await insert(client, { tenantId: t1, key: 'excl.levels', from: '2026-01-01' });
        await insert(client, {
          tenantId: t1,
          key: 'excl.levels',
          level: 'company',
          companyId: c1,
          from: '2026-01-01',
        });
      });
    });

    it('serializes two concurrent writers and refuses the loser', async () => {
      // §9's race. Two admins hit save at the same moment: the second
      // transaction blocks on the constraint until the first commits, then loses
      // — which is a 409 the client retries, not two live values for one key.
      const first = await db.app.connect();
      const second = await db.app.connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [t1]);
        }

        await insert(first, { tenantId: t1, key: 'excl.race', from: '2026-01-01' });
        const contender = insert(second, { tenantId: t1, key: 'excl.race', from: '2026-02-01' });

        await first.query('COMMIT');
        await expect(contender).rejects.toThrow(/excl_setting_values_no_overlap/);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    });
  });

  it('scopes values to one tenant', async () => {
    const rows = await withTenant(
      t2,
      async (client) =>
        (
          await client.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM setting_values WHERE key = 'excl.per-tenant'",
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(t2);
  });

  describe('definition sync (UC-SET-006)', () => {
    it('seeds the registry, then changes nothing on a re-run', async () => {
      // "Idempotent" has to mean *no writes*, not "no net change": a sync that
      // rewrote every row each release would make every deploy look like a
      // configuration change to whoever reads the audit trail.
      const first = await syncDefinitions(db.migrator);
      expect(first).toEqual({
        inserted: SETTING_DEFINITIONS.length,
        updated: 0,
        deprecated: 0,
      });

      expect(await syncDefinitions(db.migrator)).toEqual({
        inserted: 0,
        updated: 0,
        deprecated: 0,
      });
    });

    it('stamps a retired key instead of deleting it, and leaves its values alone', async () => {
      // §9 and BR-SET-001's lifecycle: values for a deprecated key stay valid
      // history — resolution simply stops asking for them.
      await db.migrator.query(
        `INSERT INTO setting_definitions (id, key, module, type, allowed_levels, default_value, description)
         VALUES ($1, 'retired.key', 'retired', 'integer', ARRAY['tenant']::setting_level[], '1'::jsonb, 'gone next release')`,
        [uuidv7()],
      );
      await withTenant(t1, (client) =>
        insert(client, { tenantId: t1, key: 'retired.key', from: '2026-01-01' }),
      );

      expect((await syncDefinitions(db.migrator)).deprecated).toBe(1);

      const { rows } = await db.migrator.query<{ deprecated_at: Date | null }>(
        "SELECT deprecated_at FROM setting_definitions WHERE key = 'retired.key'",
      );
      expect(rows[0]?.deprecated_at).toBeInstanceOf(Date);

      const values = await db.migrator.query(
        "SELECT id FROM setting_values WHERE key = 'retired.key'",
      );
      expect(values.rows).toHaveLength(1);

      // And a second run does not re-stamp what is already stamped.
      expect((await syncDefinitions(db.migrator)).deprecated).toBe(0);
    });
  });
});
