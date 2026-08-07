import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { SettingsPort } from '../../settings';
import { clearFileOwners, registerFileOwner, type FileOwner } from '../domain/categories';
import type {
  DocumentOutboxPort,
  FileRepositoryPort,
  StoragePort,
  StoredObject,
} from '../domain/document.ports';
import type { FileRow } from '../domain/document.types';
import { FileAccessService } from './access.service';
import { UploadUseCase } from './upload.use-case';

const TENANT = '01931b7c-0000-7000-8000-0000000000t1';
const EMPLOYEE = '01931b7c-0000-7000-8000-0000000000e1';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n and then some bytes');

describe('UploadUseCase (UC-DOC-001, UC-DOC-002)', () => {
  let rows: FileRow[];
  let objects: Map<string, StoredObject>;
  let emitted: { name: string; payload: Record<string, unknown> }[];
  let failures: { id: string; code: string }[];
  let permitted: boolean;
  let capMb: number;
  let uploads: UploadUseCase;

  const file = (over: Partial<FileRow> = {}): FileRow => ({
    id: 'f-1',
    module: 'employee',
    entityType: 'employee',
    entityId: EMPLOYEE,
    category: 'employee_document',
    originalName: 'ktp.png',
    storagePath: `uploads/${TENANT}/employee/${EMPLOYEE}/f-1_ktp.png`,
    mime: 'image/png',
    sizeBytes: 9,
    sha256: null,
    status: 'staged',
    commitFailureCode: null,
    documentExpiresAt: null,
    expiryRemindedAt: null,
    uploadedBy: 'u-1',
    createdAt: new Date('2026-03-10T02:00:00Z'),
    deletedAt: null,
    ...over,
  });

  const owner: FileOwner = {
    module: 'employee',
    entityTypes: ['employee'],
    canWrite: () => Promise.resolve(permitted),
    canRead: () => Promise.resolve(permitted),
    canDelete: () => Promise.resolve(permitted),
  };

  beforeEach(() => {
    clearFileOwners();
    registerFileOwner('employee_document', owner);
    registerFileOwner('generated_document', { ...owner, entityTypes: ['payslip'] });

    rows = [];
    objects = new Map();
    emitted = [];
    failures = [];
    permitted = true;
    capMb = 10;

    const repository = {
      create: (values: Record<string, unknown>) => {
        const created = file({ ...values, id: `f-${rows.length + 1}` });
        rows.push(created);
        return Promise.resolve(created);
      },
      findById: (id: string) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
      commit: (id: string, patch: Record<string, unknown>) => {
        const index = rows.findIndex((row) => row.id === id && row.status === 'staged');
        if (index < 0) return Promise.resolve(null);
        rows[index] = { ...rows[index]!, ...patch, status: 'committed' };
        return Promise.resolve(rows[index]);
      },
      recordCommitFailure: (id: string, code: string) => {
        failures.push({ id, code });
        return Promise.resolve();
      },
    } as unknown as FileRepositoryPort;

    const storage = {
      signUpload: (path: string) =>
        Promise.resolve({ url: `https://signed/${path}`, expiresAt: new Date() }),
      inspect: (path: string) => Promise.resolve(objects.get(path) ?? null),
      move: (from: string, to: string) => {
        const object = objects.get(from);
        // GCS answers 404 on a source that is not there, which is exactly what
        // the loser of a two-device confirm sees.
        if (!object)
          return Promise.reject(Object.assign(new Error('no such object'), { code: 404 }));
        objects.set(to, object);
        objects.delete(from);
        return Promise.resolve();
      },
    } as unknown as StoragePort;

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        emitted.push(event);
        return Promise.resolve();
      },
    } as unknown as DocumentOutboxPort;

    const settings = { resolve: () => Promise.resolve(capMb) } as unknown as SettingsPort;
    uploads = new UploadUseCase(repository, storage, outbox, new FileAccessService(settings));
  });

  afterEach(() => clearFileOwners());

  const run = <T>(body: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: TENANT, source: 'jwt' });
      setRequestContext({ requestId: 'r-1', userId: 'u-1' });
      return body();
    });

  const slot = (over: Record<string, unknown> = {}) =>
    uploads.requestSlot({
      category: 'employee_document',
      entityType: 'employee',
      entityId: EMPLOYEE,
      fileName: 'ktp.png',
      mime: 'image/png',
      sizeBytes: 9,
      ...over,
    });

  describe('requesting a slot', () => {
    it('writes the staged row before it signs anything', async () => {
      const result = await run(() => slot());

      expect(result.ok).toBe(true);
      // BR-DOC-001: bytes with no row do not exist for the application, so the
      // row cannot be the second write.
      expect(rows[0]?.status).toBe('staged');
      expect(rows[0]?.storagePath).toContain(`uploads/${TENANT}/employee/`);
    });

    it('refuses a mime outside the category whitelist', async () => {
      const result = await run(() => slot({ mime: 'application/zip' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('DOC_TYPE_NOT_ALLOWED');
        expect(result.error.details?.allowed).toContain('application/pdf');
      }
      expect(rows).toHaveLength(0);
    });

    it('refuses a declared size over the effective cap', async () => {
      const result = await run(() => slot({ sizeBytes: 11 * 1024 * 1024 }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DOC_SIZE_EXCEEDED');
    });

    it('tightens the cap downward from the registry ceiling, never upward', async () => {
      // BR-DOC-007/BR-SET-008: 2 MB configured under a 10 MB ceiling wins…
      capMb = 2;
      const tightened = await run(() => slot({ sizeBytes: 3 * 1024 * 1024 }));
      expect(tightened.ok).toBe(false);

      // …and 50 MB configured over it does not.
      capMb = 50;
      const loosened = await run(() => slot({ sizeBytes: 11 * 1024 * 1024 }));
      expect(loosened.ok).toBe(false);
      if (!loosened.ok) expect(loosened.error.details?.maxBytes).toBe(10 * 1024 * 1024);
    });

    it('hides the resource when the owner refuses the entity', async () => {
      permitted = false;
      const result = await run(() => slot());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('mints no slot for a worker-only category', async () => {
      // §4.2's "— (worker-only)": UC-DOC-004 writes straight to the final path.
      const result = await run(() =>
        slot({ category: 'generated_document', entityType: 'payslip', mime: 'application/pdf' }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('refuses a category nobody owns, which is every unshipped module', async () => {
      const result = await run(() => slot({ category: 'receipt', entityType: 'expense_claim' }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    });
  });

  describe('confirming (BR-DOC-004 chain)', () => {
    const upload = async (bytes: Buffer, over: Record<string, unknown> = {}) => {
      const created = await run(() => slot(over));
      if (!created.ok) throw new Error('slot failed');
      objects.set(rows[0]!.storagePath, {
        sizeBytes: bytes.length,
        head: bytes,
        sha256: 'abc123',
      });
      return created.value.fileId;
    };

    it('verifies, moves, commits and emits', async () => {
      const fileId = await upload(PNG);
      const result = await run(() => uploads.confirm(fileId));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('committed');
        expect(result.value.sha256).toBe('abc123');
        expect(result.value.storagePath).toContain(`tenants/${TENANT}/employee/`);
      }
      expect(emitted.map((event) => event.name)).toEqual(['document.file.committed']);
    });

    it('leaves the row staged with the code when no object arrived', async () => {
      const created = await run(() => slot());
      if (!created.ok) throw new Error('slot failed');

      const result = await run(() => uploads.confirm(created.value.fileId));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DOC_UPLOAD_INCOMPLETE');
      expect(rows[0]?.status).toBe('staged');
      expect(failures).toEqual([{ id: 'f-1', code: 'DOC_UPLOAD_INCOMPLETE' }]);
    });

    it('retries the same slot after a failure', async () => {
      const created = await run(() => slot());
      if (!created.ok) throw new Error('slot failed');
      await run(() => uploads.confirm(created.value.fileId));

      objects.set(rows[0]!.storagePath, { sizeBytes: 9, head: PNG, sha256: 'abc123' });
      const retried = await run(() => uploads.confirm(created.value.fileId));

      expect(retried.ok).toBe(true);
    });

    it('refuses png bytes declared as pdf, even though pdf is allowed here', async () => {
      // BR-DOC-005's sharpest edge: the mismatch is the failure, not the type.
      const fileId = await upload(PNG, { mime: 'application/pdf', fileName: 'ktp.pdf' });
      const result = await run(() => uploads.confirm(fileId));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('DOC_MIME_MISMATCH');
        expect(result.error.details).toEqual({ declared: 'application/pdf', sniffed: 'image/png' });
      }
    });

    it('accepts a correctly declared pdf', async () => {
      const fileId = await upload(PDF, {
        mime: 'application/pdf',
        fileName: 'contract.pdf',
        sizeBytes: PDF.length,
      });
      expect((await run(() => uploads.confirm(fileId))).ok).toBe(true);
    });

    it('refuses an object larger than the client declared', async () => {
      const created = await run(() => slot({ sizeBytes: 9 }));
      if (!created.ok) throw new Error('slot failed');
      objects.set(rows[0]!.storagePath, {
        sizeBytes: 5000,
        head: PNG,
        sha256: 'abc123',
      });

      const result = await run(() => uploads.confirm(created.value.fileId));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DOC_SIZE_EXCEEDED');
    });

    it('accepts an object smaller than declared and stores the verified size', async () => {
      // BR-DOC-010 has the client compress before it uploads; the row records
      // what was verified, never what was claimed.
      const created = await run(() => slot({ sizeBytes: 900_000 }));
      if (!created.ok) throw new Error('slot failed');
      objects.set(rows[0]!.storagePath, { sizeBytes: 9, head: PNG, sha256: 'abc123' });

      const result = await run(() => uploads.confirm(created.value.fileId));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.sizeBytes).toBe(9);
    });

    it('replays three times with the same answer and one event', async () => {
      const fileId = await upload(PNG);
      const answers = [
        await run(() => uploads.confirm(fileId)),
        await run(() => uploads.confirm(fileId)),
        await run(() => uploads.confirm(fileId)),
      ];

      expect(answers.every((answer) => answer.ok)).toBe(true);
      // BR-DOC-006 is what makes an offline drain safe, and an event per replay
      // would make three audit rows out of one commit.
      expect(emitted).toHaveLength(1);
    });

    it('hides the file from a caller the owner refuses', async () => {
      const fileId = await upload(PNG);
      permitted = false;

      const result = await run(() => uploads.confirm(fileId));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('hides a committed file whose object vanished behind the same 404', async () => {
      // §9's manual-surgery case reaching the confirm path: an object that is
      // not there at inspect time is `DOC_UPLOAD_INCOMPLETE` and the row stays
      // staged, which is the retry the client can act on.
      const created = await run(() => slot());
      if (!created.ok) throw new Error('slot failed');

      const result = await run(() => uploads.confirm(created.value.fileId));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DOC_UPLOAD_INCOMPLETE');
    });
  });

  /**
   * §9's two-device race, which the shared fakes cannot stage: both confirms have
   * to read a `staged` row, both reach `move`, and only then does the winner's
   * commit land. Purpose-built doubles say that in six lines.
   */
  describe('the losing half of a concurrent confirm (§9)', () => {
    const staged: FileRow = {
      id: 'f-race',
      module: 'employee',
      entityType: 'employee',
      entityId: EMPLOYEE,
      category: 'employee_document',
      originalName: 'ktp.png',
      storagePath: `uploads/${TENANT}/employee/${EMPLOYEE}/f-race_ktp.png`,
      mime: 'image/png',
      sizeBytes: 9,
      sha256: null,
      status: 'staged',
      commitFailureCode: null,
      documentExpiresAt: null,
      expiryRemindedAt: null,
      uploadedBy: 'u-1',
      createdAt: new Date('2026-03-10T02:00:00Z'),
      deletedAt: null,
    };

    const raced = (afterMove: FileRow) => {
      let reads = 0;
      const repository = {
        findById: () => Promise.resolve(reads++ === 0 ? staged : afterMove),
        commit: () => Promise.resolve(null),
        recordCommitFailure: () => Promise.resolve(),
      } as unknown as FileRepositoryPort;
      const storage = {
        inspect: () => Promise.resolve({ sizeBytes: 9, head: PNG, sha256: 'abc123' }),
        move: () => Promise.reject(Object.assign(new Error('no such object'), { code: 404 })),
      } as unknown as StoragePort;
      const settings = { resolve: () => Promise.resolve(10) } as unknown as SettingsPort;
      return new UploadUseCase(
        repository,
        storage,
        { emit: () => Promise.resolve() },
        new FileAccessService(settings),
      );
    };

    it('succeeds on the winner’s row rather than on its own move', async () => {
      const loser = raced({ ...staged, status: 'committed', sha256: 'abc123' });
      const result = await run(() => loser.confirm('f-race'));

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('committed');
    });

    it('still raises when nobody else committed — the catch is not a blanket swallow', async () => {
      const alone = raced(staged);
      await expect(run(() => alone.confirm('f-race'))).rejects.toThrow('no such object');
    });
  });
});
