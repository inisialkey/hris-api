import { Readable, Writable } from 'node:stream';

import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import { OutboxRepository } from '../src/database/outbox.repository';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { FileAccessService } from '../src/modules/document/application/access.service';
import { DeleteFileUseCase } from '../src/modules/document/application/delete.use-case';
import { DocumentJobsService } from '../src/modules/document/application/document-jobs.service';
import { DownloadUseCase } from '../src/modules/document/application/download.use-case';
import { FileQueryService } from '../src/modules/document/application/file-query.service';
import { UploadUseCase } from '../src/modules/document/application/upload.use-case';
import {
  clearFileOwners,
  registerFileOwner,
  type FileOwner,
} from '../src/modules/document/domain/categories';
import type {
  SignUploadOptions,
  StoragePort,
  StoredObject,
} from '../src/modules/document/domain/document.ports';
import { FileRepository } from '../src/modules/document/infrastructure/file.repository';
import type { SettingsPort } from '../src/modules/settings';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const PDF = Buffer.from('%PDF-1.7 a generated payslip');

/**
 * The pipeline end to end against a real database.
 *
 * The unit suite proves each decision with fakes that answer on command. Three
 * things only a database proves, and §14 names all three: the generated path
 * actually carries the tenant prefix and a sanitized name into a column, the
 * purge really removes the object before the row, and a payslip mint really
 * writes an `audit_logs` row before a URL exists.
 *
 * The bucket is the one fake, and it has to be: GCS is not a container, and a
 * signed URL nobody can verify locally would make the assertion about the fake.
 */
describe('document storage lifecycle', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let db: TestDatabase;
  let connection: ConnectionProvider;
  let unitOfWork: UnitOfWork;
  let repository: FileRepository;
  let uploads: UploadUseCase;
  let downloads: DownloadUseCase;
  let deletes: DeleteFileUseCase;
  let query: FileQueryService;
  let jobs: DocumentJobsService;

  const tenantId = uuidv7();
  const companyId = uuidv7();
  const userId = uuidv7();
  const employeeId = uuidv7();

  /** The bucket, in a Map. Object identity is the path, as it is in GCS. */
  const objects = new Map<string, Buffer>();
  let signedUploads: (SignUploadOptions & { path: string })[] = [];
  let expiryDays = 30;

  const owner: FileOwner = {
    module: 'employee',
    entityTypes: ['employee'],
    canWrite: () => Promise.resolve(true),
    canRead: () => Promise.resolve(true),
    canDelete: () => Promise.resolve(true),
  };

  const payslipOwner: FileOwner = { ...owner, module: 'payroll', entityTypes: ['payslip'] };

  const storage: StoragePort = {
    signUpload: (path, options) => {
      signedUploads.push({ path, ...options });
      return Promise.resolve({ url: `https://bucket/${path}?sig=x`, expiresAt: NOW });
    },
    signDownload: (path) =>
      Promise.resolve({ url: `https://bucket/${path}?sig=r`, expiresAt: NOW }),
    inspect: (path, headBytes): Promise<StoredObject | null> => {
      const bytes = objects.get(path);
      if (!bytes) return Promise.resolve(null);
      return Promise.resolve({
        sizeBytes: bytes.length,
        head: bytes.subarray(0, headBytes),
        // The real adapter streams a sha256; the digest's value is not what this
        // suite is about, only that a committed row carries one.
        sha256: `sha-${bytes.length}`,
      });
    },
    exists: (path) => Promise.resolve(objects.has(path)),
    move: (from, to) => {
      const bytes = objects.get(from);
      if (bytes) {
        objects.set(to, bytes);
        objects.delete(from);
      }
      return Promise.resolve();
    },
    remove: (path) => {
      objects.delete(path);
      return Promise.resolve();
    },
    // UC-DOC-004's two halves (A-200). This suite exercises the client pipeline,
    // so they are collecting sinks rather than assertions — the worker path has
    // its own coverage beside `GeneratedFileService`.
    openWrite: (path) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      sink.on('finish', () => objects.set(path, Buffer.concat(chunks)));
      return sink;
    },
    openRead: (path) => Readable.from([objects.get(path) ?? Buffer.alloc(0)]),
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'doc-lifecycle',
    ]);
    // Seeded on one connection with a session-level GUC: RLS applies to every
    // one of these tables, and `db.app` is a pool where the next statement is a
    // different connection with no tenant set.
    const client = await db.app.connect();
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    await client.query(
      'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
      [companyId, tenantId, 'C1', 'Company One'],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, status)
       VALUES ($1, $2, 'subject@example.test', 'x', 'active')`,
      [userId, tenantId],
    );
    await client.query(
      `INSERT INTO employees
         (id, tenant_id, company_id, user_id, employee_number, full_name, join_date,
          employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
       VALUES ($1, $2, $3, $4, 'E-0001', 'Subject', '2026-01-01', 'pkwtt', 'active',
               'v1:opaque', 'lifecycle-bidx', '1990-01-01', 'female', 'single', 'tk_0')`,
      [employeeId, tenantId, companyId, userId],
    );
    client.release();

    const clock = { now: () => NOW };
    const settings = {
      resolve: (key: string) =>
        Promise.resolve(key === 'document.expiry_reminder_days' ? expiryDays : 10),
    } as unknown as SettingsPort;

    repository = new FileRepository(connection);
    const audit = new AuditService(new AuditRepository(connection));
    const outbox = new OutboxRepository(connection, clock);
    const access = new FileAccessService(settings);

    uploads = new UploadUseCase(repository, storage, outbox, access);
    downloads = new DownloadUseCase(repository, storage, audit, access);
    deletes = new DeleteFileUseCase(repository, outbox, access, clock);
    query = new FileQueryService(repository);
    jobs = new DocumentJobsService(repository, storage, settings, clock);
  }, 180_000);

  beforeEach(async () => {
    clearFileOwners();
    registerFileOwner('employee_document', owner);
    registerFileOwner('generated_document', payslipOwner);
    objects.clear();
    signedUploads = [];
    expiryDays = 30;
    // One entity carries every test's files, so each one starts from an empty
    // table rather than counting its predecessors' rows.
    await db.migrator.query('TRUNCATE files, domain_events, audit_logs CASCADE');
  });

  afterAll(async () => {
    clearFileOwners();
    await db?.stop();
  }, 60_000);

  function inTenant<T>(body: () => Promise<T>): Promise<T> {
    return runInContextScope({}, async () => {
      const tenant = { tenantId, source: 'jwt' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7(), userId });
      return unitOfWork.run(tenant, body);
    });
  }

  async function upload(fileName = 'KTP scan.png', bytes = PNG) {
    return inTenant(async () => {
      const slot = await uploads.requestSlot({
        category: 'employee_document',
        entityType: 'employee',
        entityId: employeeId,
        fileName,
        mime: 'image/png',
        sizeBytes: bytes.length,
      });
      if (!slot.ok) throw new Error(`slot failed: ${slot.error.code}`);

      objects.set(signedUploads.at(-1)!.path, bytes);
      const confirmed = await uploads.confirm(slot.value.fileId);
      if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`);
      return confirmed.value;
    });
  }

  it('runs slot → PUT → confirm and lands a committed row at the final path', async () => {
    const file = await upload();

    expect(file.status).toBe('committed');
    expect(file.sha256).toBe(`sha-${PNG.length}`);
    expect(file.storagePath).toBe(
      `tenants/${tenantId}/employee/${employeeId}/${file.id}_KTP scan.png`,
    );
    // The object moved: staging is empty and the final path holds the bytes.
    expect([...objects.keys()]).toEqual([file.storagePath]);
  });

  it('carries the tenant prefix and strips traversal from the name', async () => {
    // §14's path row, and the reason sanitation lives inside the path builder
    // rather than at the edge: there is no second way in.
    const file = await upload('../../../etc/passwd.png');

    expect(file.originalName).toBe('etc_passwd.png');
    expect(file.storagePath.startsWith(`tenants/${tenantId}/`)).toBe(true);
    expect(file.storagePath).not.toContain('..');
  });

  it('constrains the signed PUT to the declared type and the effective cap', async () => {
    await upload();
    expect(signedUploads.at(-1)).toMatchObject({
      mime: 'image/png',
      maxBytes: 10 * 1024 * 1024,
      ttlSeconds: 900,
    });
  });

  it('lists the entity’s committed files and hides the staged ones', async () => {
    const committed = await upload();
    await inTenant(async () => {
      const slot = await uploads.requestSlot({
        category: 'employee_document',
        entityType: 'employee',
        entityId: employeeId,
        fileName: 'never-uploaded.png',
        mime: 'image/png',
        sizeBytes: 10,
      });
      if (!slot.ok) throw new Error('slot failed');
    });

    const listed = await inTenant(() =>
      query.listByEntity(
        { entityType: 'employee', entityId: employeeId },
        { limit: 20, offset: 0 },
      ),
    );

    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.total).toBe(1);
      expect(listed.value.rows[0]?.id).toBe(committed.id);
    }
  });

  it('writes the access record before the payslip URL exists', async () => {
    // §12, fail-closed. The row is in `audit_logs`, in the same transaction the
    // mint ran in — which is the property a fake audit port cannot show.
    const payslipId = uuidv7();
    const path = `tenants/${tenantId}/payroll/${payslipId}/${payslipId}_payslip.pdf`;
    objects.set(path, PDF);

    const fileId = await inTenant(async () => {
      const created = await repository.create({
        module: 'payroll',
        entityType: 'payslip',
        entityId: payslipId,
        category: 'generated_document',
        originalName: 'payslip.pdf',
        storagePath: path,
        mime: 'application/pdf',
        sizeBytes: PDF.length,
        status: 'committed',
        sha256: 'sha-generated',
      });
      return created.id;
    });

    const minted = await inTenant(() => downloads.mint(fileId));
    expect(minted.ok).toBe(true);

    const trail = await db.app.query(
      `SELECT action, entity_type, entity_id FROM audit_logs WHERE entity_id = $1`,
      [fileId],
    );
    expect(trail.rows).toEqual([
      { action: 'document.download.generated_document', entity_type: 'file', entity_id: fileId },
    ]);
  });

  it('refuses to delete a statutory file and keeps its object', async () => {
    const payslipId = uuidv7();
    const path = `tenants/${tenantId}/payroll/${payslipId}/${payslipId}_payslip.pdf`;
    objects.set(path, PDF);

    const fileId = await inTenant(async () => {
      const created = await repository.create({
        module: 'payroll',
        entityType: 'payslip',
        entityId: payslipId,
        category: 'generated_document',
        originalName: 'payslip.pdf',
        storagePath: path,
        mime: 'application/pdf',
        sizeBytes: PDF.length,
        status: 'committed',
        sha256: 'sha-generated',
      });
      return created.id;
    });

    const refused = await inTenant(() => deletes.remove(fileId));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('DOC_DELETE_FORBIDDEN');

    const purged = await inTenant(() => jobs.purge());
    expect(purged.purged).toBe(0);
    expect(objects.has(path)).toBe(true);
  });

  it('soft-deletes, then purges the object before the row', async () => {
    const file = await upload('deletable.png');

    const removed = await inTenant(() => deletes.remove(file.id));
    expect(removed.ok).toBe(true);
    // Still in the bucket: BR-DOC-009's object survives the row's delete flag.
    expect(objects.has(file.storagePath)).toBe(true);

    const report = await inTenant(() => jobs.purge());
    expect(report.purged).toBe(1);
    expect(objects.has(file.storagePath)).toBe(false);

    const rows = await db.app.query('SELECT id FROM files WHERE id = $1', [file.id]);
    expect(rows.rowCount).toBe(0);
  });

  it('sweeps a stale staged row and leaves a fresh one alone', async () => {
    const abandoned = await inTenant(async () => {
      const slot = await uploads.requestSlot({
        category: 'employee_document',
        entityType: 'employee',
        entityId: employeeId,
        fileName: 'abandoned.png',
        mime: 'image/png',
        sizeBytes: 10,
      });
      if (!slot.ok) throw new Error('slot failed');
      return slot.value.fileId;
    });
    // Outside the transaction that created it — another connection cannot see an
    // uncommitted row, and the age is the whole point of the assertion.
    await db.migrator.query(`UPDATE files SET created_at = $2 WHERE id = $1`, [
      abandoned,
      new Date(NOW.getTime() - 30 * 3_600_000),
    ]);
    const fresh = await upload('fresh.png');

    const report = await inTenant(() => jobs.sweepStaged());
    expect(report.purgedRows).toBe(1);

    const surviving = await db.app.query('SELECT id FROM files ORDER BY created_at');
    expect(surviving.rows.map((row: { id: string }) => row.id)).toContain(fresh.id);
  });

  it('reminds an expiring document once and stamps it', async () => {
    const file = await upload('expiring.png');
    await db.migrator.query('UPDATE files SET document_expires_at = $2 WHERE id = $1', [
      file.id,
      '2026-03-20',
    ]);

    expect(await inTenant(() => jobs.scanExpiry())).toEqual({ reminded: 1, skipped: 0 });
    expect(await inTenant(() => jobs.scanExpiry())).toEqual({ reminded: 0, skipped: 0 });

    const stamped = await db.app.query<{ expiry_reminded_at: Date }>(
      'SELECT expiry_reminded_at FROM files WHERE id = $1',
      [file.id],
    );
    expect(stamped.rows[0]?.expiry_reminded_at).toEqual(NOW);
  });

  it('emits the two events audit consumes, and one per act', async () => {
    const file = await upload('evented.png');
    await inTenant(() => deletes.remove(file.id));

    const events = await db.app.query(
      'SELECT name FROM domain_events WHERE aggregate_id = $1 ORDER BY occurred_at, name',
      [file.id],
    );
    expect(events.rows.map((row: { name: string }) => row.name)).toEqual([
      'document.file.committed',
      'document.file.deleted',
    ]);
  });
});
