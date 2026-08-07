import { randomBytes } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { EmployeeRepository } from '../src/modules/employee/infrastructure/employee.repository';
import { blindIndex } from '../src/shared/crypto/encrypted-text';
import { open, seal } from '../src/shared/crypto/aead';
import type { KeyProvider } from '../src/shared/crypto/key-provider.port';
import { TenantKeyService } from '../src/shared/crypto/tenant-key.service';
import { forgetTenantKeys } from '../src/shared/crypto/tenant-keys';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import type { EmployeeCreateInput } from '../src/modules/employee/domain/employee.types';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * ADR-0016 end to end, which is the only place it can be checked: the whole
 * mechanism is a Drizzle column type, so nothing short of a real insert and a
 * real read proves that plaintext goes in, ciphertext lands, and plaintext comes
 * back — under the right tenant's key and no other's.
 *
 * §14's row: *"raw column read shows `v1:` ciphertext; bidx deterministic per
 * tenant; cross-tenant same NIK → different bidx"*.
 */
describe('employee encryption (ADR-0016)', () => {
  let db: TestDatabase;
  let repository: EmployeeRepository;
  let keyService: TenantKeyService;

  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();
  const c2 = uuidv7();
  const NOW = new Date('2026-08-07T03:00:00Z');
  const NIK = '3201234567890001';

  /** A KEK on a laptop, in the shape `LocalKeyProvider` produces. */
  const kek = randomBytes(32);
  const provider: KeyProvider = {
    activeKekVersion: () => 'test-1',
    wrap: (plaintext) => Promise.resolve(seal(kek, plaintext.toString('base64'), 1)),
    unwrap: (wrapped) => Promise.resolve(Buffer.from(open(kek, wrapped), 'base64')),
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    const connection = new ConnectionProvider(drizzleDb);
    const unitOfWork = new UnitOfWork(drizzleDb);

    registerAuditedTables({ employees: { maskedColumns: ['ptkp_status'] } });

    keyService = new TenantKeyService(connection, provider, { now: () => NOW });
    repository = new EmployeeRepository(
      connection,
      new AuditService(new AuditRepository(connection)),
      keyService,
      { now: () => NOW },
    );

    for (const [tenantId, slug, companyId] of [
      [t1, 'enc-tenant-one', c1],
      [t2, 'enc-tenant-two', c2],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
        tenantId,
        slug,
      ]);
      // Each tenant's own DEK and index key — the blast-radius containment
      // ADR-0016 decision 4 buys, and what makes the cross-tenant assertions
      // below meaningful rather than tautological.
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
      await withTenant(tenantId, () =>
        db.migrator.query(
          'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
          [companyId, tenantId, 'C1', slug],
        ),
      );
    }

    unitOfWorkRef = unitOfWork;
  }, 180_000);

  let unitOfWorkRef: UnitOfWork;

  afterAll(async () => {
    forgetTenantKeys();
    await db?.stop();
  }, 60_000);

  function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: uuidv7() });
      return fn();
    });
  }

  function inTransaction<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return withTenant(tenantId, () => unitOfWorkRef.run({ tenantId, source: 'jwt' }, fn));
  }

  const input = (over: Partial<EmployeeCreateInput> = {}): EmployeeCreateInput => ({
    companyId: c1,
    fullName: 'Sari Dewi',
    nik: NIK,
    npwp: null,
    bankAccountNumber: '1234567890',
    bankAccountHolder: 'SARI DEWI',
    birthDate: '1990-05-04',
    gender: 'female',
    maritalStatus: 'single',
    ptkpStatus: 'tk_0',
    joinDate: '2026-01-01',
    employmentType: 'pkwtt',
    positionId: uuidv7(),
    branchId: uuidv7(),
    ...over,
  });

  it('stores ciphertext and returns plaintext', async () => {
    const created = await inTransaction(t1, async () => {
      await keyService.ensureLoaded();
      return repository.create(input({ npwp: '098765432109000' }), 'E-0001');
    });

    // The repository sees a NIK…
    expect(created.nik).toBe(NIK);

    // …and the column holds a `v1:` envelope that contains none of it.
    const { rows } = await db.migrator.query<{ nik: string; bank_account_number: string }>(
      'SELECT nik, bank_account_number FROM employees WHERE id = $1',
      [created.id],
    );
    expect(rows[0]?.nik).toMatch(/^v1:/);
    expect(rows[0]?.nik).not.toContain(NIK);
    expect(rows[0]?.bank_account_number).toMatch(/^v1:/);

    // And a read decrypts it back.
    const read = await inTransaction(t1, () => repository.findById(created.id));
    expect(read?.nik).toBe(NIK);
    expect(read?.bankAccountNumber).toBe('1234567890');
    expect(read?.bankAccountHolder).toBe('SARI DEWI');
  });

  it('leaves a NULL encrypted column NULL rather than encrypting nothing', async () => {
    const created = await inTransaction(t1, async () => {
      await keyService.ensureLoaded();
      return repository.create(input({ nik: '3201234567890002', npwp: null }), 'E-0002');
    });

    const { rows } = await db.migrator.query<{ npwp: string | null; npwp_bidx: string | null }>(
      'SELECT npwp, npwp_bidx FROM employees WHERE id = $1',
      [created.id],
    );
    expect(rows[0]?.npwp).toBeNull();
    // The blind index follows the value: no NPWP, no digest, and the partial
    // unique therefore does not treat every NPWP-less employee as the same one.
    expect(rows[0]?.npwp_bidx).toBeNull();
  });

  it('writes a blind index the repository can look the employee up by', async () => {
    const nik = '3201234567890003';
    const created = await inTransaction(t1, async () => {
      await keyService.ensureLoaded();
      return repository.create(input({ nik }), 'E-0003');
    });

    const found = await inTransaction(t1, async () => {
      const indexKey = await keyService.indexKey();
      return repository.findLiveByNikBidx(blindIndex(indexKey, nik));
    });
    expect(found?.id).toBe(created.id);
  });

  it('gives the same NIK a different digest in a different tenant', async () => {
    // The property that makes equality leak *within* a tenant and not across
    // one — the trade ADR-0016 accepted when it rejected deterministic
    // encryption in favour of a keyed index.
    const digests: string[] = [];
    for (const [tenantId, companyId, number] of [
      [t1, c1, 'E-0004'],
      [t2, c2, 'E-0004'],
    ] as const) {
      const created = await inTransaction(tenantId, async () => {
        await keyService.ensureLoaded();
        return repository.create(input({ companyId, nik: '3209999999999999', npwp: null }), number);
      });
      const { rows } = await db.migrator.query<{ nik_bidx: string }>(
        'SELECT nik_bidx FROM employees WHERE id = $1',
        [created.id],
      );
      digests.push(rows[0]?.nik_bidx ?? '');
    }

    expect(digests[0]).not.toBe(digests[1]);
    expect(digests[0]).toHaveLength(64); // hex sha256
  });

  it('cannot read one tenant’s ciphertext under another tenant’s key', async () => {
    const created = await inTransaction(t1, async () => {
      await keyService.ensureLoaded();
      return repository.create(input({ nik: '3201234567890005', npwp: null }), 'E-0005');
    });

    // Reach the row from tenant two's context. RLS hides it, which is the first
    // lock; the second is that the ciphertext would not open under that DEK
    // anyway. Assert the first, because it is the one that fires.
    const leaked = await inTransaction(t2, async () => {
      await keyService.ensureLoaded();
      return repository.findById(created.id);
    });
    expect(leaked).toBeNull();
  });

  it('refuses to touch the table at all when the tenant has no key row', async () => {
    // Fail-closed. The alternative — a default key, or a silent plaintext write
    // — is the failure ADR-0016 exists to prevent.
    const keyless = uuidv7();
    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      keyless,
      'enc-keyless',
    ]);

    await expect(inTransaction(keyless, () => keyService.ensureLoaded())).rejects.toThrow(
      /has no tenant_keys row/,
    );
  });

  it('masks the encrypted set in the audit diff without a list (BR-AUD-005 layer 1)', async () => {
    const created = await inTransaction(t1, async () => {
      await keyService.ensureLoaded();
      return repository.create(input({ nik: '3201234567890006', npwp: null }), 'E-0006');
    });

    const { rows } = await db.migrator.query<{
      diff: { changed: Record<string, unknown> };
    }>("SELECT diff FROM audit_logs WHERE entity_id = $1 AND action = 'employees.created'", [
      created.id,
    ]);
    const changed = rows[0]?.diff.changed ?? {};

    // Layer 1 derives from the column type, so every ADR-0016 column masks with
    // no entry anywhere naming it — and neither ciphertext nor plaintext lands
    // in the trail.
    for (const column of ['nik', 'bank_account_number', 'bank_account_holder']) {
      expect(changed[column]).toEqual({ masked: true });
    }
    // Layer 3, the table's §4.2 note: `ptkp_status` is unencrypted on purpose
    // (the tax engine reads it every run), so nothing about the schema would
    // mask it and the note has to.
    expect(changed.ptkp_status).toEqual({ masked: true });
    // Everything else diffs in full — an audit row that omits what changed is
    // not evidence.
    expect(changed.full_name).toEqual({ before: null, after: 'Sari Dewi' });
    expect(changed.nik_bidx).toBeDefined();
  });
});
