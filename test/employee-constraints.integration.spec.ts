import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * employee.md §14's database rows — the assertions the unit suite structurally
 * cannot make.
 *
 * `status-machine.ts` decides which transitions are legal, but *nothing stops a
 * PKWT existing with no end date* except the CHECK, and nothing stops two
 * admins renewing one employee at once except the exclusion constraint. Both are
 * only true in a database.
 */
describe('employee constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();
  const c2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'emp-tenant-one'],
      [t2, 'emp-tenant-two'],
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

  // uuidv7's leading characters are the millisecond timestamp, so slicing one
  // for a "unique" number collides inside a single test. A counter cannot.
  let sequence = 0;

  function insertEmployee(
    client: PoolClient,
    over: {
      id?: string;
      tenantId?: string;
      companyId?: string;
      number?: string;
      nikBidx?: string;
      npwpBidx?: string | null;
      status?: string;
      deleted?: boolean;
    } = {},
  ) {
    return client.query(
      `INSERT INTO employees
         (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type, status,
          nik, nik_bidx, npwp_bidx, birth_date, gender, marital_status, ptkp_status, deleted_at)
       VALUES ($1, $2, $3, $4, 'Person', '2026-01-01', 'pkwtt', $5,
               'v1:opaque', $6, $7, '1990-01-01', 'female', 'single', 'tk_0', $8)`,
      [
        over.id ?? uuidv7(),
        over.tenantId ?? t1,
        over.companyId ?? c1,
        over.number ?? `E-${String((sequence += 1)).padStart(4, '0')}`,
        over.status ?? 'active',
        over.nikBidx ?? 'bidx-shared',
        over.npwpBidx ?? null,
        over.deleted ? new Date() : null,
      ],
    );
  }

  describe('NIK uniqueness on the blind index (BR-EMP-001)', () => {
    it('refuses a second live employee holding the same NIK', async () => {
      await withTenant(t1, (client) => insertEmployee(client, { nikBidx: 'bidx-dup' }));

      await expect(
        withTenant(t1, (client) => insertEmployee(client, { nikBidx: 'bidx-dup' })),
      ).rejects.toThrow(/uq_employees_tenant_id_nik_bidx/);
    });

    it.each(['resigned', 'terminated'])(
      'frees the NIK once the holder is %s — which is what makes rehire work',
      async (status) => {
        const bidx = `bidx-rehire-${status}`;
        await withTenant(t1, (client) => insertEmployee(client, { nikBidx: bidx, status }));
        // A new row, a new employee number, the same person. Terminal rows are
        // never reactivated (BR-EMP-001).
        await withTenant(t1, (client) => insertEmployee(client, { nikBidx: bidx }));
      },
    );

    it('frees the NIK once the row is soft-deleted', async () => {
      const bidx = 'bidx-deleted';
      await withTenant(t1, (client) =>
        insertEmployee(client, { nikBidx: bidx, status: 'terminated', deleted: true }),
      );
      await withTenant(t1, (client) => insertEmployee(client, { nikBidx: bidx }));
    });

    it('lets two tenants hold the same NIK digest', async () => {
      // They cannot in practice — the HMAC key is per tenant — but the
      // constraint must be tenant-scoped regardless, or a shared digest would
      // leak the existence of a person across the isolation boundary.
      const bidx = 'bidx-cross-tenant';
      await withTenant(t1, (client) => insertEmployee(client, { nikBidx: bidx }));
      await withTenant(t2, (client) =>
        insertEmployee(client, { tenantId: t2, companyId: c2, nikBidx: bidx }),
      );
    });

    it('refuses a duplicate NPWP digest but allows many NULLs', async () => {
      await withTenant(t1, (client) =>
        insertEmployee(client, { nikBidx: uuidv7(), npwpBidx: 'npwp-dup' }),
      );
      await expect(
        withTenant(t1, (client) =>
          insertEmployee(client, { nikBidx: uuidv7(), npwpBidx: 'npwp-dup' }),
        ),
      ).rejects.toThrow(/uq_employees_tenant_id_npwp_bidx/);

      // The NIK-as-NPWP era: most employees have none, and a partial unique that
      // counted NULLs would allow exactly one of them.
      await withTenant(t1, async (client) => {
        await insertEmployee(client, { nikBidx: uuidv7(), npwpBidx: null });
        await insertEmployee(client, { nikBidx: uuidv7(), npwpBidx: null });
      });
    });
  });

  describe('contracts (BR-EMP-007)', () => {
    let employeeId: string;

    beforeAll(async () => {
      employeeId = uuidv7();
      await withTenant(t1, (client) =>
        insertEmployee(client, { id: employeeId, nikBidx: 'bidx-contracts' }),
      );
    });

    function contract(client: PoolClient, kind: string, from: string, to: string | null) {
      return client.query(
        `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), t1, employeeId, kind, from, to],
      );
    }

    it('refuses a PKWT with no end date', async () => {
      await expect(
        withTenant(t1, (client) => contract(client, 'pkwt', '2026-01-01', null)),
      ).rejects.toThrow(/ck_employee_contracts_end_by_kind/);
    });

    it('refuses a PKWTT that carries one', async () => {
      await expect(
        withTenant(t1, (client) => contract(client, 'pkwtt', '2026-01-01', '2026-12-31')),
      ).rejects.toThrow(/ck_employee_contracts_end_by_kind/);
    });

    it('refuses an overlapping range', async () => {
      await withTenant(t1, (client) => contract(client, 'pkwt', '2026-01-01', '2026-12-31'));
      await expect(
        withTenant(t1, (client) => contract(client, 'pkwt', '2026-06-01', '2027-05-31')),
      ).rejects.toThrow(/excl_employee_contracts_no_overlap/);
    });

    it('refuses a renewal starting **on** the day its predecessor ends', async () => {
      // Inclusive end (`'[]'`), unlike every other effective-dated table in the
      // system: a contract ends *on* `end_date`, so the successor starts the day
      // after. Getting this wrong would let an employee hold two contracts for
      // one day and pay them twice for it.
      await expect(
        withTenant(t1, (client) => contract(client, 'pkwt', '2026-12-31', '2027-12-30')),
      ).rejects.toThrow(/excl_employee_contracts_no_overlap/);
    });

    it('accepts a renewal starting the day after', async () => {
      await withTenant(t1, (client) => contract(client, 'pkwt', '2027-01-01', '2027-12-31'));
    });

    it('lets a soft-deleted contract stop occupying its range', async () => {
      const other = uuidv7();
      await withTenant(t1, async (client) => {
        await insertEmployee(client, { id: other, nikBidx: 'bidx-deleted-contract' });
        await client.query(
          `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, end_date, deleted_at)
           VALUES ($1, $2, $3, 'pkwt', '2026-01-01', '2026-12-31', now())`,
          [uuidv7(), t1, other],
        );
        await client.query(
          `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, end_date)
           VALUES ($1, $2, $3, 'pkwt', '2026-01-01', '2026-12-31')`,
          [uuidv7(), t1, other],
        );
      });
    });

    it('serializes two concurrent renewals and refuses the loser', async () => {
      const racer = uuidv7();
      await withTenant(t1, (client) => insertEmployee(client, { id: racer, nikBidx: 'bidx-race' }));

      const first = await db.app.connect();
      const second = await db.app.connect();
      try {
        for (const client of [first, second]) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.tenant_id', $1, true)", [t1]);
        }

        const insert = (client: PoolClient, from: string, to: string) =>
          client.query(
            `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, end_date)
             VALUES ($1, $2, $3, 'pkwt', $4, $5)`,
            [uuidv7(), t1, racer, from, to],
          );

        await insert(first, '2026-01-01', '2026-12-31');
        const contender = insert(second, '2026-06-01', '2027-05-31');

        await first.query('COMMIT');
        await expect(contender).rejects.toThrow(/excl_employee_contracts_no_overlap/);
      } finally {
        await first.query('ROLLBACK').catch(() => undefined);
        await second.query('ROLLBACK').catch(() => undefined);
        first.release();
        second.release();
      }
    });
  });

  describe('tenant isolation', () => {
    it.each(['employee_contracts', 'employee_status_history', 'employee_family_members'])(
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
            `INSERT INTO employee_family_members (id, tenant_id, employee_id, name, relationship)
             VALUES ($1, $2, $3, 'X', 'spouse')`,
            [uuidv7(), t1, uuidv7()],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('hides another tenant’s rows through employee_directory too', async () => {
      // `security_invoker = true` is what makes this true. Without it the view
      // would run with its owner's rights and return every tenant's employees —
      // a convenience join turned into a cross-tenant read (ADR-0001 rule 6c).
      const mine = await withTenant(
        t1,
        async (client) =>
          (await client.query<{ n: string }>('SELECT count(*)::text AS n FROM employee_directory'))
            .rows[0]?.n,
      );
      const theirs = await withTenant(
        t2,
        async (client) =>
          (await client.query<{ n: string }>('SELECT count(*)::text AS n FROM employee_directory'))
            .rows[0]?.n,
      );

      expect(Number(mine)).toBeGreaterThan(0);
      expect(Number(theirs)).toBe(1); // the one row tenant two inserted itself
    });

    it('excludes soft-deleted rows from the view', async () => {
      const gone = uuidv7();
      await withTenant(t1, (client) =>
        insertEmployee(client, {
          id: gone,
          nikBidx: uuidv7(),
          status: 'terminated',
          deleted: true,
        }),
      );

      const rows = await withTenant(
        t1,
        async (client) =>
          (
            await client.query<{ employee_id: string }>(
              'SELECT employee_id FROM employee_directory WHERE employee_id = $1',
              [gone],
            )
          ).rows,
      );
      expect(rows).toHaveLength(0);
    });
  });
});
