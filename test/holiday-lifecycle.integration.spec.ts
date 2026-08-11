import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { HolidayRepository } from '../src/modules/holiday/infrastructure/holiday.repository';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The holiday repository against a real database: the scope predicate `/sync`
 * pages over, the tombstones a device evicts on, and BR-HOL-009's audit trail.
 *
 * The scope predicate is the part worth a container. It is three nullable
 * columns and an `OR` — tenant-wide rows, the caller's company, the caller's
 * branch — and a fake that filters an array in JavaScript agrees with any
 * predicate at all, including one that leaks another branch's calendar into an
 * employee's phone.
 */
describe('holiday lifecycle', () => {
  let db: TestDatabase;
  let drizzleDb: Database;
  let unitOfWork: UnitOfWork;
  let holidays: HolidayRepository;

  const tenantId = uuidv7();
  const userId = uuidv7();
  const companyA = uuidv7();
  const companyB = uuidv7();
  const branchA = uuidv7();
  const branchB = uuidv7();
  const NOW = new Date('2026-08-11T03:00:00Z');

  beforeAll(async () => {
    db = await startTestDatabase();
    drizzleDb = drizzle(db.app, { schema });

    const connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);
    registerAuditedTables({ holidays: {} });
    holidays = new HolidayRepository(
      connection,
      new AuditService(new AuditRepository(connection)),
      {
        now: () => NOW,
      },
    );

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'holiday-tenant',
    ]);
    // Fixtures go in as the migrator: they are the *other* modules' tables, and
    // this suite is about `holidays`.
    await db.migrator.query(
      `INSERT INTO companies (id, tenant_id, code, name)
       VALUES ($1, $3, 'A', 'Company A'), ($2, $3, 'B', 'Company B')`,
      [companyA, companyB, tenantId],
    );
    await db.migrator.query(
      `INSERT INTO branches (id, tenant_id, company_id, code, name, timezone)
       VALUES ($1, $3, $4, 'HO', 'Head office', 'Asia/Jakarta'),
              ($2, $3, $4, 'BR2', 'Second', 'Asia/Makassar')`,
      [branchA, branchB, tenantId, companyA],
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query('TRUNCATE holidays, audit_logs CASCADE');
  });

  function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId });
      return unitOfWork.run({ tenantId, source: 'jwt' }, fn);
    });
  }

  const day = {
    date: '2026-05-01',
    name: 'National day A',
    kind: 'national' as const,
    observed: true,
  };

  it('reads back what it wrote, live rows only', async () => {
    const created = await inRequest(() =>
      holidays.create({ ...day, companyId: null, branchId: null }),
    );
    const found = await inRequest(() => holidays.inRange('2026-05-01', '2026-05-02'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: created.id, name: 'National day A' });

    await inRequest(() => holidays.softDelete(created.id));
    expect(await inRequest(() => holidays.inRange('2026-05-01', '2026-05-02'))).toEqual([]);
    expect(await inRequest(() => holidays.findById(created.id))).toBeNull();
  });

  describe('BR-HOL-009 — channel-1 audit', () => {
    it('writes a diff row per mutation, inside the mutating transaction', async () => {
      const created = await inRequest(() =>
        holidays.create({ ...day, companyId: null, branchId: null }),
      );
      await inRequest(() => holidays.update(created.id, { name: 'renamed' }));
      await inRequest(() => holidays.softDelete(created.id));

      const { rows } = await db.migrator.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY occurred_at, action`,
        [created.id],
      );
      expect(rows.map((row) => row.action).sort()).toEqual([
        'holidays.created',
        'holidays.deleted',
        'holidays.updated',
      ]);
    });

    it('rolls the trail back with the change', async () => {
      const id = uuidv7();
      await expect(
        inRequest(async () => {
          await holidays.create({ ...day, companyId: null, branchId: null });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      const { rows } = await db.migrator.query<{ total: string }>(
        'SELECT count(*) AS total FROM audit_logs',
      );
      expect(rows[0]?.total).toBe('0');
      expect(await inRequest(() => holidays.findById(id))).toBeNull();
    });
  });

  describe('§7 /sync — the device scope predicate', () => {
    async function seedScopes(): Promise<void> {
      await inRequest(async () => {
        await holidays.create({ ...day, companyId: null, branchId: null });
        await holidays.create({
          ...day,
          kind: 'custom',
          name: 'Company A day',
          companyId: companyA,
          branchId: null,
        });
        await holidays.create({
          ...day,
          kind: 'cuti_bersama',
          name: 'Branch A day',
          companyId: companyA,
          branchId: branchA,
        });
        await holidays.create({
          ...day,
          kind: 'cuti_bersama',
          name: 'Branch B day',
          companyId: companyA,
          branchId: branchB,
        });
        await holidays.create({
          ...day,
          kind: 'custom',
          name: 'Company B day',
          companyId: companyB,
          branchId: null,
        });
      });
    }

    it('gives a branch employee tenant-wide, own-company and own-branch rows and nothing else', async () => {
      await seedScopes();
      const rows = await inRequest(() =>
        holidays.changedSince({ companyId: companyA, branchId: branchA }, null, null, 50),
      );
      expect(rows.map((row) => row.name).sort()).toEqual([
        'Branch A day',
        'Company A day',
        'National day A',
      ]);
    });

    it('gives an unplaced employee their company’s rows without any branch’s', async () => {
      await seedScopes();
      const rows = await inRequest(() =>
        holidays.changedSince({ companyId: companyA, branchId: null }, null, null, 50),
      );
      expect(rows.map((row) => row.name).sort()).toEqual(['Company A day', 'National day A']);
    });

    it('gives an account with no employment the tenant-wide rows only', async () => {
      await seedScopes();
      const rows = await inRequest(() =>
        holidays.changedSince({ companyId: null, branchId: null }, null, null, 50),
      );
      expect(rows.map((row) => row.name)).toEqual(['National day A']);
    });

    it('includes tombstones so a device can evict', async () => {
      const created = await inRequest(() =>
        holidays.create({ ...day, companyId: null, branchId: null }),
      );
      await inRequest(() => holidays.softDelete(created.id));

      const rows = await inRequest(() =>
        holidays.changedSince({ companyId: companyA, branchId: branchA }, null, null, 50),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deletedAt).not.toBeNull();
    });

    it('pages deterministically on (updated_at, id)', async () => {
      await inRequest(async () => {
        for (let index = 0; index < 5; index += 1) {
          await holidays.create({
            ...day,
            kind: 'custom',
            name: `Day ${index}`,
            date: `2026-05-0${index + 1}`,
            companyId: null,
            branchId: null,
          });
        }
      });

      // Every row shares one transaction timestamp, which is the case a
      // millisecond-truncated cursor gets wrong: it re-serves the page forever.
      const scope = { companyId: companyA, branchId: branchA };
      const seen: string[] = [];
      let cursor: { id: string } | null = null;
      for (let page = 0; page < 4; page += 1) {
        const rows = await inRequest(() => holidays.changedSince(scope, null, cursor, 2));
        if (rows.length === 0) break;
        seen.push(...rows.map((row) => row.id));
        cursor = { id: rows[rows.length - 1]!.id };
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });
});
