import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * organization.md §14's database rows — the assertions the unit suite
 * structurally cannot make.
 *
 * `plan-placement.ts` decides where a placement goes, but *nothing stops two
 * admins deciding at once* except the exclusion constraint, and nothing stops a
 * fourth timezone reaching `branches` except the CHECK. Both are only true in a
 * database.
 */
describe('organization constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();
  const c2 = uuidv7();
  const b1 = uuidv7();
  const d1 = uuidv7();
  const l1 = uuidv7();
  const p1 = uuidv7();
  const e1 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'org-tenant-one'],
      [t2, 'org-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await withTenant(t1, async (client) => {
      await client.query(
        'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [c1, t1, 'C1', 'Company One'],
      );
      await client.query(
        `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
         VALUES ($1, $2, $3, 'JKT', 'Jakarta', 'Asia/Jakarta')`,
        [b1, t1, c1],
      );
      await client.query(
        `INSERT INTO departments (id, tenant_id, company_id, code, name)
         VALUES ($1, $2, $3, 'FIN', 'Finance')`,
        [d1, t1, c1],
      );
      await client.query(
        `INSERT INTO job_levels (id, tenant_id, code, name, rank) VALUES ($1, $2, 'L3', 'Manager', 3)`,
        [l1, t1],
      );
      await client.query(
        `INSERT INTO positions (id, tenant_id, company_id, department_id, job_level_id, code, title)
         VALUES ($1, $2, $3, $4, $5, 'FIN-MGR', 'Finance Manager')`,
        [p1, t1, c1, d1, l1],
      );
      await client.query(
        `INSERT INTO employees (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type)
         VALUES ($1, $2, $3, 'E-001', 'Sari', '2026-01-01', 'pkwtt')`,
        [e1, t1, c1],
      );
    });

    await withTenant(t2, (client) =>
      client.query('INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)', [
        c2,
        t2,
        'C1',
        'Other Tenant Company',
      ]),
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

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

  function assign(
    client: PoolClient,
    over: { employeeId?: string; from: string; to?: string | null; deleted?: boolean },
  ) {
    return client.query(
      `INSERT INTO org_assignments
         (id, tenant_id, employee_id, position_id, branch_id, kind, effective_from, effective_to, deleted_at)
       VALUES ($1, $2, $3, $4, $5, 'transfer', $6, $7, $8)`,
      [
        uuidv7(),
        t1,
        over.employeeId ?? e1,
        p1,
        b1,
        over.from,
        over.to ?? null,
        over.deleted ? new Date() : null,
      ],
    );
  }

  describe('branch CHECKs (BR-ORG-001, §8)', () => {
    it('refuses a timezone outside the three Indonesian zones', async () => {
      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
             VALUES ($1, $2, $3, 'SGP', 'Singapore', 'Asia/Singapore')`,
            [uuidv7(), t1, c1],
          ),
        ),
      ).rejects.toThrow(/ck_branches_timezone/);
    });

    it('accepts each of the three', async () => {
      await withTenant(t1, async (client) => {
        for (const [index, zone] of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'].entries()) {
          await client.query(
            `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv7(), t1, c1, `TZ${String(index)}`, `Zone ${String(index)}`, zone],
          );
        }
      });
    });

    it('refuses half a geofence centre', async () => {
      // One coordinate is not a partially-known location, it is a bug attendance
      // would read as one.
      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone, latitude)
             VALUES ($1, $2, $3, 'HALF', 'Half', 'Asia/Jakarta', -6.2)`,
            [uuidv7(), t1, c1],
          ),
        ),
      ).rejects.toThrow(/ck_branches_coordinates/);
    });
  });

  describe('one live placement per employee (BR-ORG-002)', () => {
    it('refuses a backdated range that collides with history', async () => {
      await withTenant(t1, (client) => assign(client, { from: '2026-01-01' }));

      await expect(
        withTenant(t1, (client) => assign(client, { from: '2026-06-01' })),
      ).rejects.toThrow(/excl_org_assignments_no_overlap/);
    });

    it('accepts adjacent ranges that share a boundary date', async () => {
      // `[)` — the boundary belongs to the successor, so history is contiguous
      // with no gap and no overlap.
      const other = uuidv7();
      await withTenant(t1, async (client) => {
        await client.query(
          `INSERT INTO employees (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type)
           VALUES ($1, $2, $3, 'E-002', 'Budi', '2026-01-01', 'pkwtt')`,
          [other, t1, c1],
        );
        await assign(client, { employeeId: other, from: '2026-01-01', to: '2026-06-01' });
        await assign(client, { employeeId: other, from: '2026-06-01' });
      });
    });

    it('lets a cancelled row stop occupying its range', async () => {
      // UC-ORG-004 reopens the predecessor in the same transaction as the
      // soft delete. Without `WHERE deleted_at IS NULL` on the constraint, the
      // reopened predecessor would collide with the row that was just cancelled.
      const other = uuidv7();
      await withTenant(t1, async (client) => {
        await client.query(
          `INSERT INTO employees (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type)
           VALUES ($1, $2, $3, 'E-003', 'Dewi', '2026-01-01', 'pkwtt')`,
          [other, t1, c1],
        );
        await assign(client, { employeeId: other, from: '2026-09-01', deleted: true });
        await assign(client, { employeeId: other, from: '2026-01-01' });
      });
    });

    it('serializes two concurrent movers and refuses the loser', async () => {
      const mover = uuidv7();
      await withTenant(t1, (client) =>
        client.query(
          `INSERT INTO employees (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type)
           VALUES ($1, $2, $3, 'E-004', 'Rama', '2026-01-01', 'pkwtt')`,
          [mover, t1, c1],
        ),
      );

      const first = await db.app.connect();
      const second = await db.app.connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [t1]);
        }

        await assign(first, { employeeId: mover, from: '2026-01-01' });
        const contender = assign(second, { employeeId: mover, from: '2026-02-01' });

        await first.query('COMMIT');
        await expect(contender).rejects.toThrow(/excl_org_assignments_no_overlap/);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    });
  });

  describe('tenant isolation', () => {
    it.each(['branches', 'departments', 'job_levels', 'positions', 'org_assignments'])(
      'scopes %s to one tenant',
      async (table) => {
        const rows = await withTenant(
          t2,
          async (client) => (await client.query<{ id: string }>(`SELECT id FROM ${table}`)).rows,
        );
        expect(rows).toHaveLength(0);
      },
    );

    it('refuses a row written under another tenant’s context', async () => {
      await expect(
        withTenant(t2, (client) =>
          client.query(
            `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
             VALUES ($1, $2, $3, 'X', 'Cross', 'Asia/Jakarta')`,
            [uuidv7(), t1, c1],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('fulfils the deferred branch foreign key on setting_values', async () => {
    // settings.md §4.1 shipped `branch_id` FK-less because `branches` did not
    // exist yet. This migration is where that promise is kept.
    await expect(
      withTenant(t1, (client) =>
        client.query(
          `INSERT INTO setting_values (id, tenant_id, key, level, company_id, branch_id, value, effective_from)
           VALUES ($1, $2, 'org.fk', 'branch', $3, $4, '1'::jsonb, '2026-01-01')`,
          [uuidv7(), t1, c1, uuidv7()],
        ),
      ),
    ).rejects.toThrow(/fk_setting_values_branches/);
  });
});
