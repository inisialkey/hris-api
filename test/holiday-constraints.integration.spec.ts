import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * `holidays`' database rules — the assertions no unit test can make.
 *
 * BR-HOL-003 is the sharp one. The key is `(scope, date, kind)` and two of the
 * three scope columns are **nullable**, so the obvious unique index would not
 * hold at all: `NULL` never equals `NULL`, and a tenant-wide row could be
 * inserted a hundred times without ever colliding with itself. The `COALESCE` to
 * the nil UUID is what makes the constraint real, and a fake repository that
 * compares `row.companyId === input.companyId` in JavaScript proves only that the
 * service reads its own fake.
 */
describe('holiday constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const companyA = uuidv7();
  const companyB = uuidv7();
  const branchA = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'hol-tenant-one'],
      [t2, 'hol-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await withTenant(t1, async (client) => {
      await client.query(
        `INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, 'A', 'Company A'), ($3, $2, 'B', 'Company B')`,
        [companyA, t1, companyB],
      );
      await client.query(
        `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
         VALUES ($1, $2, $3, 'HO', 'Head office', 'Asia/Jakarta')`,
        [branchA, t1, companyA],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query('TRUNCATE holidays CASCADE');
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

  function insert(
    client: PoolClient,
    values: {
      tenantId: string;
      companyId?: string | null;
      branchId?: string | null;
      date?: string;
      kind?: string;
      name?: string;
      observed?: boolean;
      id?: string;
    },
  ) {
    return client.query(
      `INSERT INTO holidays (id, tenant_id, company_id, branch_id, date, name, kind, observed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        values.id ?? uuidv7(),
        values.tenantId,
        values.companyId ?? null,
        values.branchId ?? null,
        values.date ?? '2026-05-01',
        values.name ?? 'National day A',
        values.kind ?? 'national',
        values.observed ?? true,
      ],
    );
  }

  describe('BR-HOL-003 — one row per (scope, date, kind)', () => {
    it('refuses a second tenant-wide row for the same date and kind', async () => {
      await withTenant(t1, async (client) => {
        await insert(client, { tenantId: t1 });
        await expect(insert(client, { tenantId: t1 })).rejects.toThrow(
          /uq_holidays_scope_date_kind/,
        );
      });
    });

    it('permits the same date and kind at a narrower scope', async () => {
      await withTenant(t1, async (client) => {
        await insert(client, { tenantId: t1 });
        await insert(client, { tenantId: t1, companyId: companyA, observed: false });
        await insert(client, {
          tenantId: t1,
          companyId: companyA,
          branchId: branchA,
          observed: true,
        });
        const rows = await client.query<{ total: number }>(
          'SELECT count(*)::int AS total FROM holidays',
        );
        expect(rows.rows[0]?.total).toBe(3);
      });
    });

    it('permits two kinds on one date at one scope', async () => {
      await withTenant(t1, async (client) => {
        await insert(client, { tenantId: t1, kind: 'national' });
        await insert(client, { tenantId: t1, kind: 'cuti_bersama', name: 'Cuti bersama A' });
      });
    });

    it('refuses two companies’ rows colliding only because both are NULL-branched', async () => {
      await withTenant(t1, async (client) => {
        await insert(client, { tenantId: t1, companyId: companyA });
        await insert(client, { tenantId: t1, companyId: companyB });
        await expect(insert(client, { tenantId: t1, companyId: companyB })).rejects.toThrow(
          /uq_holidays_scope_date_kind/,
        );
      });
    });

    it('frees the key when the row is soft-deleted (§4.3, partial unique)', async () => {
      await withTenant(t1, async (client) => {
        const id = uuidv7();
        await insert(client, { tenantId: t1, id });
        await client.query('UPDATE holidays SET deleted_at = now() WHERE id = $1', [id]);
        await insert(client, { tenantId: t1 });
      });
    });

    it('does not collide across tenants', async () => {
      await withTenant(t1, (client) => insert(client, { tenantId: t1 }));
      await withTenant(t2, (client) => insert(client, { tenantId: t2 }));
    });
  });

  describe('BR-HOL-005 — branch scope implies company scope', () => {
    it('refuses a branch row with no company', async () => {
      await withTenant(t1, async (client) => {
        await expect(
          insert(client, { tenantId: t1, companyId: null, branchId: branchA }),
        ).rejects.toThrow(/ck_holidays_scope_pair/);
      });
    });
  });

  describe('ADR-0002 — RLS', () => {
    it('L1: a read under T2 never sees T1 rows', async () => {
      await withTenant(t1, (client) => insert(client, { tenantId: t1 }));
      const rows = await withTenant(t2, (client) => client.query('SELECT id FROM holidays'));
      expect(rows.rowCount).toBe(0);
    });

    it('L2: a read with no tenant variable returns zero rows rather than erroring', async () => {
      await withTenant(t1, (client) => insert(client, { tenantId: t1 }));
      const client = await db.app.connect();
      try {
        // A fresh pooled connection that has already served a tenant reverts the
        // setting to the empty string, which is what `NULLIF` exists for
        // (database-conventions §9.2).
        const rows = await client.query('SELECT id FROM holidays');
        expect(rows.rowCount).toBe(0);
      } finally {
        client.release();
      }
    });

    it('L3: a write smuggling another tenant’s id is rejected', async () => {
      await withTenant(t1, async (client) => {
        await expect(insert(client, { tenantId: t2 })).rejects.toThrow(/row-level security/);
      });
    });
  });
});
