import { clearFileOwners, registerFileOwner, type FileOwner } from '../domain/categories';
import type { FileRepositoryPort, StoragePort } from '../domain/document.ports';
import type { FileRow } from '../domain/document.types';
import type { SettingsPort } from '../../settings';
import { FileAccessService } from './access.service';
import { DownloadUseCase } from './download.use-case';

describe('DownloadUseCase (UC-DOC-003)', () => {
  let rows: FileRow[];
  let missingObjects: Set<string>;
  let reads: { key: string; entityId?: string }[];
  let auditFails: boolean;
  let permitted: boolean;
  let signedTtl: number | null;
  let downloads: DownloadUseCase;

  const file = (over: Partial<FileRow> = {}): FileRow => ({
    id: 'f-1',
    module: 'employee',
    entityType: 'employee',
    entityId: 'e-1',
    category: 'employee_document',
    originalName: 'ktp.png',
    storagePath: 'tenants/t/employee/e-1/f-1_ktp.png',
    mime: 'image/png',
    sizeBytes: 9,
    sha256: 'abc',
    status: 'committed',
    commitFailureCode: null,
    documentExpiresAt: null,
    expiryRemindedAt: null,
    uploadedBy: 'u-1',
    createdAt: new Date('2026-03-10T02:00:00Z'),
    deletedAt: null,
    ...over,
  });

  const owner = (entityTypes: string[]): FileOwner => ({
    module: 'employee',
    entityTypes,
    canWrite: () => Promise.resolve(permitted),
    canRead: () => Promise.resolve(permitted),
    canDelete: () => Promise.resolve(permitted),
  });

  beforeEach(() => {
    clearFileOwners();
    registerFileOwner('employee_document', owner(['employee']));
    registerFileOwner('generated_document', owner(['payslip']));

    rows = [file()];
    missingObjects = new Set();
    reads = [];
    auditFails = false;
    permitted = true;
    signedTtl = null;

    const repository = {
      findById: (id: string) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
    } as unknown as FileRepositoryPort;

    const storage = {
      exists: (path: string) => Promise.resolve(!missingObjects.has(path)),
      signDownload: (path: string, ttlSeconds: number) => {
        signedTtl = ttlSeconds;
        return Promise.resolve({ url: `https://signed/${path}`, expiresAt: new Date() });
      },
    } as unknown as StoragePort;

    const audit = {
      sensitiveRead: (key: string, _entityType: string, entityId?: string) => {
        if (auditFails) return Promise.reject(new Error('audit insert failed'));
        reads.push({ key, entityId });
        return Promise.resolve();
      },
    };

    const settings = { resolve: () => Promise.resolve(10) } as unknown as SettingsPort;
    downloads = new DownloadUseCase(repository, storage, audit, new FileAccessService(settings));
  });

  afterEach(() => clearFileOwners());

  it('mints a URL for the category TTL', async () => {
    const result = await downloads.mint('f-1');

    expect(result.ok).toBe(true);
    expect(signedTtl).toBe(600);
    expect(reads).toEqual([]);
  });

  it('hides a staged row — an upload in flight is not a document', async () => {
    rows = [file({ status: 'staged' })];
    const result = await downloads.mint('f-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('re-checks authorization on every mint, so revocation bites at the next one', async () => {
    expect((await downloads.mint('f-1')).ok).toBe(true);
    permitted = false;

    const revoked = await downloads.mint('f-1');
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('SYS_NOT_FOUND');
  });

  it('audits a payslip mint before signing, and shortens the window to 120 s', async () => {
    rows = [
      file({ category: 'generated_document', entityType: 'payslip', mime: 'application/pdf' }),
    ];

    const result = await downloads.mint('f-1');

    expect(result.ok).toBe(true);
    expect(reads).toEqual([{ key: 'document.download.generated_document', entityId: 'f-1' }]);
    expect(signedTtl).toBe(120);
  });

  it('refuses the mint when the access record cannot be written', async () => {
    // audit-log UC-AUD-003, fail-closed: a read audit that can be dropped is not
    // an access record, so the URL never exists.
    rows = [
      file({ category: 'generated_document', entityType: 'payslip', mime: 'application/pdf' }),
    ];
    auditFails = true;

    await expect(downloads.mint('f-1')).rejects.toThrow('audit insert failed');
    expect(signedTtl).toBeNull();
  });

  it('lets an owner flag a per-file sensitive read', async () => {
    // §12's `document.download.gated_export` half: whether an export output
    // carries gated columns is a fact only the module that froze it holds.
    clearFileOwners();
    registerFileOwner('import_file', {
      ...owner(['import_job']),
      sensitiveReadKey: () => Promise.resolve('document.download.gated_export'),
    });
    rows = [
      file({
        category: 'import_file',
        entityType: 'import_job',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ];

    expect((await downloads.mint('f-1')).ok).toBe(true);
    expect(reads.map((read) => read.key)).toEqual(['document.download.gated_export']);
  });

  it('is loud when the bucket and the metadata disagree', async () => {
    // §9's manual-surgery case. `SYS_INTERNAL`, never a 404: a committed row
    // whose object vanished is a system defect, and answering "not found" would
    // file it as a user error.
    missingObjects.add(rows[0]!.storagePath);
    const result = await downloads.mint('f-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SYS_INTERNAL');
  });
});
