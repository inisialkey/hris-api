import type { FileRow } from '../../document';
import { clearDefinitions, registerImportDefinition } from '../domain/definitions';
import { DefinitionAccessService } from './definition-access.service';
import { ImportFileOwner } from './import-file.owner';
import { FakeExportJobs, FakeImportJobs, importDefinition, inScope, NOW } from './test-support';

const PERMISSION = 'employee.master.import';

function file(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: 'file-1',
    module: 'import-export',
    entityType: 'export_job',
    entityId: 'export-1',
    category: 'import_file',
    originalName: 'employee.master.xlsx',
    storagePath: 'tenants/x/import-export/file-1',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 1,
    sha256: 'sha',
    status: 'committed',
    commitFailureCode: null,
    documentExpiresAt: null,
    expiryRemindedAt: null,
    uploadedBy: null,
    createdAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

describe('ImportFileOwner — BR-IMP-010’s one category, three answers', () => {
  let imports: FakeImportJobs;
  let exports_: FakeExportJobs;
  let owner: ImportFileOwner;

  beforeEach(() => {
    clearDefinitions();
    registerImportDefinition(importDefinition());
    imports = new FakeImportJobs();
    exports_ = new FakeExportJobs();
    owner = new ImportFileOwner(imports, exports_, new DefinitionAccessService());
  });

  describe('canWrite — the slot, and only the slot', () => {
    it('lets a holder of any import permission park a slot under themselves', async () => {
      const allowed = await inScope('user-a', [PERMISSION], () =>
        owner.canWrite({ entityType: 'user', entityId: 'user-a' }),
      );
      expect(allowed).toBe(true);
    });

    it('refuses a caller who holds no import definition permission at all', async () => {
      const allowed = await inScope('user-a', ['import-export.job.read'], () =>
        owner.canWrite({ entityType: 'user', entityId: 'user-a' }),
      );
      expect(allowed).toBe(false);
    });

    it('refuses parking a slot under somebody else’s id', async () => {
      // Otherwise a caller could stage a file under another user and claim it.
      const allowed = await inScope('user-a', [PERMISSION], () =>
        owner.canWrite({ entityType: 'user', entityId: 'user-b' }),
      );
      expect(allowed).toBe(false);
    });

    it('refuses a write against a job entity — a worker does not come through here', async () => {
      for (const entityType of ['import_job', 'export_job']) {
        const allowed = await inScope('user-a', [PERMISSION], () =>
          owner.canWrite({ entityType, entityId: 'job-1' }),
        );
        expect(allowed).toBe(false);
      }
    });
  });

  describe('canRead — the asymmetry the rule was grilled into', () => {
    it('lets any definition-permission holder read an import job’s files', async () => {
      const job = imports.seed({ type: 'employee.master', status: 'completed' });
      // `user-b` never touched this job; §2 makes the artifacts tenant records.
      const allowed = await inScope('user-b', [PERMISSION], () =>
        owner.canRead({ entityType: 'import_job', entityId: job.id }),
      );
      expect(allowed).toBe(true);
    });

    it('refuses an import job’s files to a caller without that definition’s permission', async () => {
      const job = imports.seed({ type: 'employee.master', status: 'completed' });
      const allowed = await inScope('user-b', ['holiday.calendar.import'], () =>
        owner.canRead({ entityType: 'import_job', entityId: job.id }),
      );
      expect(allowed).toBe(false);
    });

    it('§14: lets the requester download an export output', async () => {
      const job = exports_.seed({ type: 'employee.master', requestedBy: 'user-a' });
      const allowed = await inScope('user-a', [], () =>
        owner.canRead({ entityType: 'export_job', entityId: job.id }),
      );
      expect(allowed).toBe(true);
    });

    it('§14: refuses a non-requester holding job.read — the bytes narrow, the row does not', async () => {
      const job = exports_.seed({ type: 'employee.master', requestedBy: 'user-a' });
      const allowed = await inScope(
        'user-b',
        ['import-export.job.read', 'employee.master.export'],
        () => owner.canRead({ entityType: 'export_job', entityId: job.id }),
      );
      expect(allowed).toBe(false);
    });

    it('lets the uploader read a slot that has not been claimed by a job yet', async () => {
      expect(
        await inScope('user-a', [], () =>
          owner.canRead({ entityType: 'user', entityId: 'user-a' }),
        ),
      ).toBe(true);
      expect(
        await inScope('user-b', [], () =>
          owner.canRead({ entityType: 'user', entityId: 'user-a' }),
        ),
      ).toBe(false);
    });

    it('refuses a job id that does not resolve, and an entity type it does not own', async () => {
      expect(
        await inScope('user-a', [PERMISSION], () =>
          owner.canRead({ entityType: 'import_job', entityId: 'missing' }),
        ),
      ).toBe(false);
      expect(
        await inScope('user-a', [PERMISSION], () =>
          owner.canRead({ entityType: 'employee', entityId: 'x' }),
        ),
      ).toBe(false);
    });
  });

  it('never permits a client delete — the category is a job artifact', async () => {
    expect(await owner.canDelete()).toBe(false);
  });

  describe('sensitiveReadKey — BR-IMP-010’s audited mint', () => {
    it('registers the read when the frozen column set included a gated column', async () => {
      const job = exports_.seed({
        type: 'employee.master',
        fileId: 'file-1',
        params: { _columns: ['number', 'nik'], _gated: true },
      });
      expect(await owner.sensitiveReadKey(file({ entityId: job.id }))).toBe(
        'document.download.gated_export',
      );
    });

    it('registers nothing when the same definition was frozen without gated columns', async () => {
      // The distinction is per file rather than per category, which is exactly
      // why the hook lives on the owner.
      const job = exports_.seed({
        type: 'employee.master',
        fileId: 'file-1',
        params: { _columns: ['number'], _gated: false },
      });
      expect(await owner.sensitiveReadKey(file({ entityId: job.id }))).toBeNull();
    });

    it('registers nothing for an import artifact', async () => {
      const job = imports.seed({ type: 'employee.master', status: 'completed' });
      expect(
        await owner.sensitiveReadKey(file({ entityType: 'import_job', entityId: job.id })),
      ).toBeNull();
    });
  });
});
