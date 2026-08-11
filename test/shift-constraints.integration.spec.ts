import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The five shift tables' database rules — the assertions no unit test can make.
 *
 * `excl_roster_assignments_no_overlap` is the sharp one. BR-SHF-007 asks for two
 * invariants — one live arrangement per employee, one live default per company —
 * and both are carried by **one** gist exclusion keyed on
 * `COALESCE(employee_id, company_id)`. The planner closes the interval it is
 * about to fill, so the only thing that can violate this is a race, and a race is
 * exactly what an in-memory fake cannot stage.
 */
describe('shift constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const companyA = uuidv7();
  const companyB = uuidv7();
  const branchA = uuidv7();
  const employeeA = uuidv7();
  const employeeB = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'shf-tenant-one'],
      [t2, 'shf-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await db.migrator.query(
      `INSERT INTO companies (id, tenant_id, code, name)
       VALUES ($1, $3, 'A', 'Company A'), ($2, $3, 'B', 'Company B')`,
      [companyA, companyB, t1],
    );
    await db.migrator.query(
      `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
       VALUES ($1, $2, $3, 'HO', 'Head office', 'Asia/Jakarta')`,
      [branchA, t1, companyA],
    );
    for (const [id, number] of [
      [employeeA, 'EMP-0001'],
      [employeeB, 'EMP-0002'],
    ] as const) {
      await db.migrator.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, employee_number, full_name, join_date, employment_type, status,
            nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, $4, 'Budi', '2020-01-01', 'pkwtt', 'active',
                 'v1:x', $4, '1990-01-01', 'male', 'single', 'tk_0')`,
        [id, t1, companyA, number],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query(
      'TRUNCATE roster_days, roster_assignments, shift_pattern_days, shift_patterns, shifts CASCADE',
    );
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

  function insertShift(
    client: PoolClient,
    values: {
      id?: string;
      tenantId?: string;
      companyId?: string;
      code?: string;
      startTime?: string;
      endTime?: string;
      breakMinutes?: number;
      lateTolerance?: number;
      punchIn?: number;
    } = {},
  ) {
    return client.query(
      `INSERT INTO shifts
         (id, tenant_id, company_id, code, name, start_time, end_time, break_minutes,
          late_tolerance_minutes, early_leave_tolerance_minutes,
          punch_in_before_minutes, punch_out_after_minutes)
       VALUES ($1, $2, $3, $4, 'Shift', $5, $6, $7, $8, 0, $9, 60)`,
      [
        values.id ?? uuidv7(),
        values.tenantId ?? t1,
        values.companyId ?? companyA,
        values.code ?? 'OFFICE',
        values.startTime ?? '08:00',
        values.endTime ?? '17:00',
        values.breakMinutes ?? 60,
        values.lateTolerance ?? 10,
        values.punchIn ?? 60,
      ],
    );
  }

  async function insertPattern(client: PoolClient, cycleLength = 7): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO shift_patterns (id, tenant_id, company_id, code, name, cycle_length)
       VALUES ($1, $2, $3, $4, 'Pattern', $5)`,
      [id, t1, companyA, `PAT-${id.slice(0, 8)}`, cycleLength],
    );
    return id;
  }

  function insertAssignment(
    client: PoolClient,
    values: {
      employeeId?: string | null;
      companyId?: string;
      patternId: string;
      from: string;
      to?: string | null;
      deleted?: boolean;
    },
  ) {
    return client.query(
      `INSERT INTO roster_assignments
         (id, tenant_id, company_id, employee_id, pattern_id, cycle_anchor_date,
          effective_from, effective_to, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
      [
        uuidv7(),
        t1,
        values.companyId ?? companyA,
        values.employeeId === undefined ? employeeA : values.employeeId,
        values.patternId,
        values.from,
        values.to ?? null,
        values.deleted ? new Date() : null,
      ],
    );
  }

  describe('BR-SHF-001 — a shift is a window', () => {
    it('refuses equal start and end times', async () => {
      await withTenant(t1, async (client) => {
        await expect(insertShift(client, { startTime: '08:00', endTime: '08:00' })).rejects.toThrow(
          /ck_shifts_times_differ/,
        );
      });
    });

    it('accepts an end before the start — that is a night shift', async () => {
      await withTenant(t1, (client) =>
        insertShift(client, { code: 'NIGHT', startTime: '22:00', endTime: '06:00' }),
      );
    });

    it('refuses a negative tolerance', async () => {
      await withTenant(t1, async (client) => {
        await expect(insertShift(client, { lateTolerance: -1 })).rejects.toThrow(
          /ck_shifts_tolerances_non_negative/,
        );
      });
    });

    it('refuses a negative punch window', async () => {
      await withTenant(t1, async (client) => {
        await expect(insertShift(client, { punchIn: -30 })).rejects.toThrow(
          /ck_shifts_tolerances_non_negative/,
        );
      });
    });

    it('keeps codes unique per company among live rows, and frees them on archive', async () => {
      // One transaction per statement: a constraint violation aborts the whole
      // block, so a test that asserts a rejection *and then* a success cannot
      // share one.
      const id = uuidv7();
      await withTenant(t1, (client) => insertShift(client, { id, code: 'OFFICE' }));
      await expect(
        withTenant(t1, (client) => insertShift(client, { code: 'OFFICE' })),
      ).rejects.toThrow(/uq_shifts_tenant_id_company_id_code/);

      await withTenant(t1, (client) =>
        client.query('UPDATE shifts SET deleted_at = now() WHERE id = $1', [id]),
      );
      await withTenant(t1, (client) => insertShift(client, { code: 'OFFICE' }));
    });

    it('lets two companies hold the same code', async () => {
      await withTenant(t1, async (client) => {
        await insertShift(client, { code: 'OFFICE' });
        await insertShift(client, { code: 'OFFICE', companyId: companyB });
      });
    });
  });

  describe('§4.1 — the pattern CHECKs', () => {
    it('refuses a cycle length outside 1..31', async () => {
      await expect(withTenant(t1, (client) => insertPattern(client, 0))).rejects.toThrow(
        /ck_shift_patterns_cycle_length/,
      );
      await expect(withTenant(t1, (client) => insertPattern(client, 32))).rejects.toThrow(
        /ck_shift_patterns_cycle_length/,
      );
      await withTenant(t1, (client) => insertPattern(client, 31));
    });

    it('refuses a negative day index and keeps one entry per index', async () => {
      const patternId = await withTenant(t1, (client) => insertPattern(client, 2));
      const entry = (index: number) => (client: PoolClient) =>
        client.query(
          `INSERT INTO shift_pattern_days (id, tenant_id, pattern_id, day_index)
           VALUES ($1, $2, $3, $4)`,
          [uuidv7(), t1, patternId, index],
        );

      await expect(withTenant(t1, entry(-1))).rejects.toThrow(/ck_shift_pattern_days_day_index/);
      await withTenant(t1, entry(0));
      await expect(withTenant(t1, entry(0))).rejects.toThrow(
        /uq_shift_pattern_days_tenant_id_pattern_id_day_index/,
      );
    });
  });

  describe('BR-SHF-007 — one live arrangement, one live default', () => {
    it('refuses two overlapping assignments for one employee', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { patternId, from: '2026-09-01' });
        await expect(insertAssignment(client, { patternId, from: '2026-10-01' })).rejects.toThrow(
          /excl_roster_assignments_no_overlap/,
        );
      });
    });

    it('accepts adjacent ranges sharing a boundary date — the half-open interval', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { patternId, from: '2026-09-01', to: '2026-10-01' });
        await insertAssignment(client, { patternId, from: '2026-10-01' });
      });
    });

    it('refuses a second live company default', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { employeeId: null, patternId, from: '2026-09-01' });
        await expect(
          insertAssignment(client, { employeeId: null, patternId, from: '2026-10-01' }),
        ).rejects.toThrow(/excl_roster_assignments_no_overlap/);
      });
    });

    it('lets two employees overlap freely — the key is per employee', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { patternId, from: '2026-09-01' });
        await insertAssignment(client, { employeeId: employeeB, patternId, from: '2026-09-01' });
      });
    });

    it('lets an employee row and the company default overlap — the ladder is what picks', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { patternId, from: '2026-09-01' });
        await insertAssignment(client, { employeeId: null, patternId, from: '2026-09-01' });
      });
    });

    it('excludes cancelled rows from the constraint', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertAssignment(client, { patternId, from: '2026-09-01', deleted: true });
        await insertAssignment(client, { patternId, from: '2026-09-15' });
      });
    });
  });

  describe('BR-SHF-005 — one roster day per employee per date', () => {
    it('refuses a second live row for the same date and frees the key on delete', async () => {
      const id = uuidv7();
      const insert = (rowId: string) => (client: PoolClient) =>
        client.query(
          `INSERT INTO roster_days (id, tenant_id, employee_id, date) VALUES ($1, $2, $3, '2026-09-15')`,
          [rowId, t1, employeeA],
        );

      await withTenant(t1, insert(id));
      await expect(withTenant(t1, insert(uuidv7()))).rejects.toThrow(
        /uq_roster_days_tenant_id_employee_id_date/,
      );
      await withTenant(t1, (client) =>
        client.query('UPDATE roster_days SET deleted_at = now() WHERE id = $1', [id]),
      );
      await withTenant(t1, insert(uuidv7()));
    });
  });

  describe('ADR-0002 — RLS on all five tables', () => {
    it('L1: another tenant sees none of them', async () => {
      await withTenant(t1, async (client) => {
        const patternId = await insertPattern(client);
        await insertShift(client);
        await insertAssignment(client, { patternId, from: '2026-09-01' });
        await client.query(
          `INSERT INTO roster_days (id, tenant_id, employee_id, date) VALUES ($1, $2, $3, '2026-09-15')`,
          [uuidv7(), t1, employeeA],
        );
      });

      const counts = await withTenant(t2, async (client) => {
        const rows = await client.query<{ total: string }>(
          `SELECT (SELECT count(*) FROM shifts)
                + (SELECT count(*) FROM shift_patterns)
                + (SELECT count(*) FROM roster_assignments)
                + (SELECT count(*) FROM roster_days) AS total`,
        );
        return rows.rows[0]?.total;
      });
      expect(counts).toBe('0');
    });

    it('L3: a write smuggling another tenant’s id is rejected', async () => {
      await withTenant(t1, async (client) => {
        await expect(insertShift(client, { tenantId: t2 })).rejects.toThrow(/row-level security/);
      });
    });
  });
});
