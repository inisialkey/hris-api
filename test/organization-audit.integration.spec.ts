import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { BranchRepository } from '../src/modules/organization/infrastructure/branch.repository';
import { CompanyRepository } from '../src/modules/organization/infrastructure/company.repository';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * BR-ORG-009 and BR-AUD-002 end to end: every mutation on an audited table
 * leaves a diff row, written **inside the mutating transaction**.
 *
 * The unit suite proves the diff is shaped correctly; only a database can prove
 * it is atomic with the change, and that the trail survives a rollback of
 * nothing and disappears on a rollback of something.
 */
describe('organization channel-1 audit', () => {
  let db: TestDatabase;
  let drizzleDb: Database;
  let unitOfWork: UnitOfWork;
  let companies: CompanyRepository;
  let branches: BranchRepository;

  const tenantId = uuidv7();
  const userId = uuidv7();
  const NOW = new Date('2026-08-06T03:00:00Z');

  beforeAll(async () => {
    db = await startTestDatabase();
    drizzleDb = drizzle(db.app, { schema });

    const connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    // The registry the repositories assert against at construction — §4.2's
    // fail-loud gate is the reason this line is not optional.
    registerAuditedTables({ companies: {}, branches: {} });

    const audit = new AuditService(new AuditRepository(connection));
    companies = new CompanyRepository(connection, audit, { now: () => NOW });
    branches = new BranchRepository(connection, audit, { now: () => NOW });

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'audit-tenant',
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  function inRequest<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId });
      return unitOfWork.run({ tenantId, source: 'jwt' }, fn);
    });
  }

  async function trail(entityId: string) {
    const { rows } = await db.migrator.query<{
      action: string;
      entity_type: string;
      actor_user_id: string | null;
      request_id: string | null;
      diff: { changed: Record<string, unknown> };
    }>(
      `SELECT action, entity_type, actor_user_id, request_id, diff
         FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [entityId],
    );
    return rows;
  }

  it('files a created row carrying only the after side', async () => {
    const company = await inRequest(() =>
      companies.create({
        code: 'AUD1',
        name: 'Audited One',
        legalName: null,
        npwp: '1234567890123456',
        address: null,
        phone: null,
      }),
    );

    const rows = await trail(company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'companies.created',
      entity_type: 'companies',
      actor_user_id: userId,
      request_id: 'req-1',
    });
    expect(rows[0]?.diff.changed).toMatchObject({
      code: { before: null, after: 'AUD1' },
      name: { before: null, after: 'Audited One' },
    });
  });

  it('names only the columns an update moved', async () => {
    const company = await inRequest(() =>
      companies.create({
        code: 'AUD2',
        name: 'Audited Two',
        legalName: null,
        npwp: null,
        address: null,
        phone: null,
      }),
    );

    await inRequest(() => companies.update(company.id, { name: 'Renamed', phone: '+62800' }));

    const rows = await trail(company.id);
    expect(rows.map((row) => row.action)).toEqual(['companies.created', 'companies.updated']);
    expect(Object.keys(rows[1]?.diff.changed ?? {}).sort()).toEqual(['name', 'phone']);
    expect(rows[1]?.diff.changed.name).toEqual({ before: 'Audited Two', after: 'Renamed' });
  });

  it('files nothing for an update that changed nothing', async () => {
    const company = await inRequest(() =>
      companies.create({
        code: 'AUD3',
        name: 'Audited Three',
        legalName: null,
        npwp: null,
        address: null,
        phone: null,
      }),
    );

    await inRequest(() => companies.update(company.id, { name: 'Audited Three' }));

    expect((await trail(company.id)).map((row) => row.action)).toEqual(['companies.created']);
  });

  it('files a deleted row carrying only the before side', async () => {
    const company = await inRequest(() =>
      companies.create({
        code: 'AUD4',
        name: 'Audited Four',
        legalName: null,
        npwp: null,
        address: null,
        phone: null,
      }),
    );

    await inRequest(() => companies.archive(company.id));

    const rows = await trail(company.id);
    expect(rows.map((row) => row.action)).toEqual(['companies.created', 'companies.deleted']);
    expect(rows[1]?.diff.changed.name).toEqual({ before: 'Audited Four', after: null });
  });

  it('rolls the audit row back with the change that caused it', async () => {
    // The property BR-AUD-002 exists for: no phantom rows on rollback, which a
    // queue-based or after-commit hook could not promise.
    const doomed = uuidv7();
    await expect(
      inRequest(async () => {
        await companies.create({
          code: 'AUD5',
          name: 'Doomed',
          legalName: null,
          npwp: null,
          address: null,
          phone: null,
        });
        throw new Error(`abort ${doomed}`);
      }),
    ).rejects.toThrow(doomed);

    const { rows } = await db.migrator.query(
      "SELECT id FROM audit_logs WHERE diff->'changed'->'code'->>'after' = 'AUD5'",
    );
    expect(rows).toHaveLength(0);
  });

  it('audits a second table on the same base', async () => {
    const company = await inRequest(() =>
      companies.create({
        code: 'AUD6',
        name: 'Audited Six',
        legalName: null,
        npwp: null,
        address: null,
        phone: null,
      }),
    );

    const branch = await inRequest(() =>
      branches.create({
        companyId: company.id,
        code: 'JKT',
        name: 'Jakarta',
        timezone: 'Asia/Jakarta',
        address: null,
        latitude: null,
        longitude: null,
      }),
    );

    const rows = await trail(branch.id);
    expect(rows[0]).toMatchObject({ action: 'branches.created', entity_type: 'branches' });
    expect(rows[0]?.diff.changed.timezone).toEqual({ before: null, after: 'Asia/Jakarta' });
  });
});
