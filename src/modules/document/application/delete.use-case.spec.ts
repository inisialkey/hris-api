import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { SettingsPort } from '../../settings';
import { clearFileOwners, registerFileOwner, type FileOwner } from '../domain/categories';
import type { DocumentOutboxPort, FileRepositoryPort } from '../domain/document.ports';
import type { FileRow } from '../domain/document.types';
import { FileAccessService } from './access.service';
import { DeleteFileUseCase } from './delete.use-case';

const TENANT = '01931b7c-0000-7000-8000-0000000000t1';

describe('DeleteFileUseCase (UC-DOC-005)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let rows: FileRow[];
  let emitted: { name: string; payload: Record<string, unknown> }[];
  let readable: boolean;
  let deletable: boolean;
  let deletes: DeleteFileUseCase;

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
    createdAt: NOW,
    deletedAt: null,
    ...over,
  });

  const owner = (entityTypes: string[]): FileOwner => ({
    module: 'employee',
    entityTypes,
    canWrite: () => Promise.resolve(deletable),
    canRead: () => Promise.resolve(readable),
    canDelete: () => Promise.resolve(deletable),
  });

  beforeEach(() => {
    clearFileOwners();
    registerFileOwner('employee_document', owner(['employee']));
    registerFileOwner('generated_document', owner(['payslip']));

    rows = [file()];
    emitted = [];
    readable = true;
    deletable = true;

    const repository = {
      findById: (id: string) =>
        Promise.resolve(rows.find((row) => row.id === id && !row.deletedAt) ?? null),
      softDelete: (id: string, at: Date) => {
        const index = rows.findIndex((row) => row.id === id && !row.deletedAt);
        if (index < 0) return Promise.resolve(null);
        rows[index] = { ...rows[index]!, deletedAt: at };
        return Promise.resolve(rows[index]);
      },
    } as unknown as FileRepositoryPort;

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        emitted.push(event);
        return Promise.resolve();
      },
    } as unknown as DocumentOutboxPort;

    const settings = { resolve: () => Promise.resolve(10) } as unknown as SettingsPort;
    deletes = new DeleteFileUseCase(repository, outbox, new FileAccessService(settings), {
      now: () => NOW,
    });
  });

  afterEach(() => clearFileOwners());

  const run = <T>(body: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: TENANT, source: 'jwt' });
      setRequestContext({ requestId: 'r-1', userId: 'u-1' });
      return body();
    });

  it('soft-deletes and emits, leaving the object for the purge job', async () => {
    // BR-DOC-009's single direction: the row goes first and the object follows,
    // because the reverse can strand a committed row pointing at nothing.
    const result = await run(() => deletes.remove('f-1'));

    expect(result.ok).toBe(true);
    expect(rows[0]?.deletedAt).toEqual(NOW);
    expect(emitted).toEqual([
      {
        name: 'document.file.deleted',
        tenantId: TENANT,
        aggregateId: 'f-1',
        payload: { fileId: 'f-1', category: 'employee_document' },
      },
    ]);
  });

  it('refuses a statutory category with a code, not a 404', async () => {
    rows = [file({ category: 'generated_document', entityType: 'payslip' })];

    const result = await run(() => deletes.remove('f-1'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DOC_DELETE_FORBIDDEN');
      expect(result.error.details).toEqual({ category: 'generated_document' });
    }
    expect(emitted).toEqual([]);
  });

  it('hides a retained file from someone who cannot see it in the first place', async () => {
    // The order matters: `DOC_DELETE_FORBIDDEN` tells the caller the file exists
    // and is kept, which is only safe once they can already see it.
    rows = [file({ category: 'generated_document', entityType: 'payslip' })];
    readable = false;

    const result = await run(() => deletes.remove('f-1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('separates seeing from removing — read yes, delete no', async () => {
    deletable = false;

    const result = await run(() => deletes.remove('f-1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('is a 404 the second time, so a double delete emits once', async () => {
    await run(() => deletes.remove('f-1'));
    const again = await run(() => deletes.remove('f-1'));

    expect(again.ok).toBe(false);
    expect(emitted).toHaveLength(1);
  });
});
