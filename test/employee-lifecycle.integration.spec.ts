import { randomBytes } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { EffectuateService } from '../src/modules/employee/application/effectuate.service';
import { EmployeeRepository } from '../src/modules/employee/infrastructure/employee.repository';
import { StatusHistoryRepository } from '../src/modules/employee/infrastructure/status-history.repository';
import { open, seal } from '../src/shared/crypto/aead';
import type { KeyProvider } from '../src/shared/crypto/key-provider.port';
import { TenantKeyService } from '../src/shared/crypto/tenant-key.service';
import { forgetTenantKeys } from '../src/shared/crypto/tenant-keys';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { ok } from '../src/shared/result';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * UC-EMP-007's idempotency, against a real row lock.
 *
 * The unit suite proves the *decision* — claim first, then effects — with a fake
 * that answers `true` or `false` on command. Only a database proves the claim is
 * atomic, and that is the whole property: two runners reaching one due row must
 * produce one status change and one event, not two.
 */
describe('employee status effectuation (UC-EMP-007)', () => {
  let db: TestDatabase;
  let connection: ConnectionProvider;
  let unitOfWork: UnitOfWork;
  let employees: EmployeeRepository;
  let history: StatusHistoryRepository;

  const tenantId = uuidv7();
  const companyId = uuidv7();
  const NOW = new Date('2026-08-07T03:00:00Z');
  const kek = randomBytes(32);

  const provider: KeyProvider = {
    activeKekVersion: () => 'test-1',
    wrap: (plaintext) => Promise.resolve(seal(kek, plaintext.toString('base64'), 1)),
    unwrap: (wrapped) => Promise.resolve(Buffer.from(open(kek, wrapped), 'base64')),
  };

  let closedAssignments: { employeeId: string; date: string }[] = [];
  let deactivated: string[] = [];
  let emitted: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    registerAuditedTables({ employees: { maskedColumns: ['ptkp_status'] } });

    // **Wall clock, not the frozen business clock.** `TenantKeyService` writes the
    // cache expiry from the clock it is given, while the `encryptedText` column
    // type reads it back through `Date.now()` — it is synchronous and
    // context-free, which is the whole of ADR-0016 decision 2. Handing this one a
    // fixed `NOW` made the key expire the moment real time passed it, so the
    // suite only passed within five minutes of 03:00 UTC. The TTL is machinery,
    // not a business rule (`tenant-keys.ts` says so).
    const keys = new TenantKeyService(connection, provider, { now: () => new Date() });
    const audit = new AuditService(new AuditRepository(connection));
    employees = new EmployeeRepository(connection, audit, keys, { now: () => NOW });
    history = new StatusHistoryRepository(connection, { now: () => NOW });

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'lifecycle-tenant',
    ]);
    await db.app.query(
      `INSERT INTO tenant_keys (id, tenant_id, wrapped_dek, wrapped_index_key, kek_version)
       VALUES ($1, $2, $3, $4, 'test-1')`,
      [
        uuidv7(),
        tenantId,
        await provider.wrap(randomBytes(32)),
        await provider.wrap(randomBytes(32)),
      ],
    );
    // `hris_migrator` carries BYPASSRLS, so fixture rows need no tenant
    // transaction — the assertions below read through it too.
    await db.migrator.query(
      'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
      [companyId, tenantId, 'C1', 'Lifecycle Co'],
    );
  }, 180_000);

  afterAll(async () => {
    forgetTenantKeys();
    await db?.stop();
  }, 60_000);

  beforeEach(() => {
    closedAssignments = [];
    deactivated = [];
    emitted = [];
  });

  function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: uuidv7() });
      return unitOfWork.run({ tenantId, source: 'jwt' }, fn);
    });
  }

  function buildEffectuator() {
    return new EffectuateService(
      employees,
      history,
      {
        assignOnHire: () => Promise.resolve(ok(undefined)),
        closeOnExit: (employeeId: string, date: string) => {
          closedAssignments.push({ employeeId, date });
          return Promise.resolve(ok(undefined));
        },
      },
      {
        createUserForEmployee: () => Promise.resolve(ok({ userId: 'u' })),
        deactivateUser: (userId: string) => {
          deactivated.push(userId);
          return Promise.resolve();
        },
      },
      {
        emit: (event) => {
          emitted.push(event.payload);
          return Promise.resolve();
        },
      },
      { now: () => NOW },
    );
  }

  let sequence = 0;

  /**
   * Seeded **through the repository**, not with raw SQL. A hand-written `nik`
   * would have to be real ciphertext under this tenant's DEK, and the DEK exists
   * only wrapped — so the repository is both the shortest path and the honest
   * one, since it is what the code under test reads back through.
   */
  async function seedEmployee(withLogin = false): Promise<{ id: string; userId: string | null }> {
    sequence += 1;
    const number = `L-${String(sequence).padStart(4, '0')}`;
    let userId: string | null = null;

    if (withLogin) {
      userId = uuidv7();
      await db.migrator.query(
        'INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)',
        [userId, tenantId, `${number.toLowerCase()}@lifecycle.test`, 'x'],
      );
    }

    const created = await inTransaction(async () => {
      const row = await employees.create(
        {
          companyId,
          fullName: 'Person',
          nik: `320123456789${String(sequence).padStart(4, '0')}`,
          birthDate: '1990-01-01',
          gender: 'male',
          maritalStatus: 'single',
          ptkpStatus: 'tk_0',
          joinDate: '2026-01-01',
          employmentType: 'pkwtt',
          positionId: uuidv7(),
          branchId: uuidv7(),
        },
        number,
      );
      if (userId) await employees.linkUser(row.id, userId);
      return row;
    });

    return { id: created.id, userId };
  }

  async function seedSchedule(employeeId: string, status: string, date: string): Promise<string> {
    const id = uuidv7();
    await db.migrator.query(
      `INSERT INTO employee_status_history
         (id, tenant_id, employee_id, status, source, effective_date)
       VALUES ($1, $2, $3, $4, 'termination', $5)`,
      [id, tenantId, employeeId, status, date],
    );
    return id;
  }

  it('applies a due schedule exactly once across two concurrent runners', async () => {
    const { id: employeeId, userId } = await seedEmployee(true);
    await seedSchedule(employeeId, 'terminated', '2026-08-01');

    // Both runners open their own transaction and race the same row. The
    // `applied_at IS NULL` guard in the UPDATE is a row lock: the loser blocks,
    // then sees zero rows and does nothing.
    const results = await Promise.all([
      inTransaction(() => buildEffectuator().runDue('2026-08-07')),
      inTransaction(() => buildEffectuator().runDue('2026-08-07')),
    ]);

    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(closedAssignments).toHaveLength(1);
    expect(deactivated).toEqual([userId]);

    const { rows } = await db.migrator.query<{ status: string }>(
      'SELECT status FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(rows[0]?.status).toBe('terminated');
  });

  it('is idempotent when re-run — a crashed job resumes without double-applying', async () => {
    const { id: employeeId } = await seedEmployee();
    await seedSchedule(employeeId, 'resigned', '2026-08-02');

    expect(await inTransaction(() => buildEffectuator().runDue('2026-08-07'))).toBe(1);
    expect(await inTransaction(() => buildEffectuator().runDue('2026-08-07'))).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  it('leaves a future schedule alone', async () => {
    const { id: employeeId } = await seedEmployee();
    await seedSchedule(employeeId, 'terminated', '2026-12-01');

    expect(await inTransaction(() => buildEffectuator().runDue('2026-08-07'))).toBe(0);
    const { rows } = await db.migrator.query<{ status: string }>(
      'SELECT status FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('applies an employee’s schedules in effective-date order', async () => {
    // An employee can hold a scheduled `on_leave` and a scheduled `resigned` at
    // once. Newest-first would leave the status reading `on_leave` after the
    // person had gone.
    const { id: employeeId } = await seedEmployee();
    await db.migrator.query(
      `INSERT INTO employee_status_history
         (id, tenant_id, employee_id, status, source, effective_date)
       VALUES ($1, $2, $3, 'on_leave', 'leave', '2026-08-03'),
              ($4, $2, $3, 'resigned', 'resignation', '2026-08-05')`,
      [uuidv7(), tenantId, employeeId, uuidv7()],
    );

    expect(await inTransaction(() => buildEffectuator().runDue('2026-08-07'))).toBe(2);
    expect(emitted.map((e) => e.status)).toEqual(['on_leave', 'resigned']);

    const { rows } = await db.migrator.query<{ status: string }>(
      'SELECT status FROM employees WHERE id = $1',
      [employeeId],
    );
    expect(rows[0]?.status).toBe('resigned');
  });

  it('rolls the whole effectuation back when a side effect refuses', async () => {
    // A locked period. Committing would leave an exited employee still holding
    // a seat; rolling back leaves the schedule unclaimed for the next run.
    const { id: employeeId } = await seedEmployee();
    const scheduleId = await seedSchedule(employeeId, 'terminated', '2026-08-04');

    const refusing = () =>
      new EffectuateService(
        employees,
        history,
        {
          assignOnHire: () => Promise.resolve(ok(undefined)),
          closeOnExit: () =>
            Promise.resolve({
              ok: false as const,
              error: { code: 'ORG_PERIOD_LOCKED', messageKey: 'errors.ORG_PERIOD_LOCKED' },
            }),
        },
        {
          createUserForEmployee: () => Promise.resolve(ok({ userId: 'u' })),
          deactivateUser: () => Promise.resolve(),
        },
        { emit: () => Promise.resolve() },
        { now: () => NOW },
      );

    await expect(inTransaction(() => refusing().runDue('2026-08-07'))).rejects.toThrow(
      /ORG_PERIOD_LOCKED/,
    );

    const { rows } = await db.migrator.query<{ applied_at: Date | null; status: string }>(
      `SELECT h.applied_at, e.status
         FROM employee_status_history h JOIN employees e ON e.id = h.employee_id
        WHERE h.id = $1`,
      [scheduleId],
    );
    expect(rows[0]?.applied_at).toBeNull();
    expect(rows[0]?.status).toBe('active');
  });
});
