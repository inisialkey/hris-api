import type { NotificationPort, SendCommand } from '../../notification';
import { clearDefinitions, registerExportDefinition, type ExportRow } from '../domain/definitions';
import type { ImportExportOutboxPort, WorkbookWriterPort } from '../domain/import-export.ports';
import { DefinitionAccessService } from './definition-access.service';
import { ExportService } from './export.service';
import {
  clock,
  exportDefinition,
  FakeDocuments,
  FakeExportJobs,
  inScope,
  text,
} from './test-support';

const COMPANY = '018f2f4a-6d1e-7c00-9a2b-3c4d5e6f7a8b';
const EXPORT = 'employee.master.export';
const GATED = 'employee.sensitive.read';

describe('ExportService — UC-IMP-006', () => {
  let jobs: FakeExportJobs;
  let documents: FakeDocuments;
  let sent: SendCommand[];
  let emitted: Parameters<ImportExportOutboxPort['emit']>[0][];
  let streamed: ExportRow[];
  let writtenColumns: string[];
  let service: ExportService;

  beforeEach(() => {
    clearDefinitions();
    streamed = [
      { number: 'EMP-1', name: 'Budi', nik: '3201' },
      { number: 'EMP-2', name: 'Siti', nik: '3202' },
    ];
    registerExportDefinition(
      exportDefinition({
        queryPort: {
          // eslint-disable-next-line @typescript-eslint/require-await
          stream: async function* () {
            yield* streamed;
          },
        },
      }),
    );

    jobs = new FakeExportJobs();
    documents = new FakeDocuments();
    sent = [];
    emitted = [];
    writtenColumns = [];

    const writer: Pick<WorkbookWriterPort, 'exportRows'> = {
      exportRows: async (input) => {
        writtenColumns = input.columns.map((column) => column.key);
        let count = 0;
        for await (const _row of input.stream) count += 1;
        return count;
      },
    };

    service = new ExportService(
      jobs,
      documents,
      writer as WorkbookWriterPort,
      {
        send: (command: SendCommand) => {
          sent.push(command);
          return Promise.resolve({ created: 1, deduped: 0, suppressed: 0 });
        },
      } as NotificationPort,
      {
        emit: (event: Parameters<ImportExportOutboxPort['emit']>[0]) => {
          emitted.push(event);
          return Promise.resolve();
        },
      },
      clock,
      new DefinitionAccessService(),
    );
  });

  describe('enqueue — BR-IMP-010’s entitlement freeze', () => {
    it('freezes the base set alone for a requester without the gated permission', async () => {
      const queued = await inScope('user-a', [EXPORT], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );

      expect(queued.ok).toBe(true);
      if (!queued.ok) return;
      expect(queued.value.status).toBe('queued');
      expect(queued.value.params).toEqual({
        companyId: COMPANY,
        _columns: ['number', 'name'],
        _gated: false,
      });
    });

    it('freezes the gated columns in for a requester who holds them, and flags the file', async () => {
      const queued = await inScope('user-a', [EXPORT, GATED], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );
      if (!queued.ok) throw new Error('expected a job');
      expect(queued.value.params).toMatchObject({
        _columns: ['number', 'name', 'nik'],
        _gated: true,
      });
    });

    it('refuses a body that fails the ParamSpec, before any job exists', async () => {
      const queued = await inScope('user-a', [EXPORT], () =>
        service.enqueue('employee.master', {}),
      );
      expect(queued.ok).toBe(false);
      if (!queued.ok) expect(queued.error.code).toBe('VAL_VALIDATION_FAILED');
      expect(jobs.rows.size).toBe(0);
    });

    it('hides a definition the caller may not run', async () => {
      const queued = await inScope('user-a', [], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );
      expect(queued.ok).toBe(false);
      if (!queued.ok) expect(queued.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('resolves a definition-resolved definition’s permission before the freeze', async () => {
      clearDefinitions();
      registerExportDefinition(
        exportDefinition({
          key: 'report.result',
          requiredPermission: 'report.result.read',
          params: [{ key: 'reportKey', type: 'string', required: true }],
          columnSets: { base: [{ key: 'x', header: text('X') }] },
          resolve: (params) =>
            Promise.resolve({
              requiredPermission: `report.${String(params.reportKey)}.read`,
              columnSets: { base: [{ key: 'y', header: text('Y') }] },

              queryPort: { stream: async function* () {} },
            }),
        }),
      );

      const refused = await inScope('user-a', ['report.result.read'], () =>
        service.enqueue('report.result', { reportKey: 'headcount' }),
      );
      expect(refused.ok).toBe(false);

      const allowed = await inScope('user-a', ['report.result.read', 'report.headcount.read'], () =>
        service.enqueue('report.result', { reportKey: 'headcount' }),
      );
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect(allowed.value.params._columns).toEqual(['y']);
    });
  });

  describe('generate', () => {
    it('writes the frozen columns, stores the file and completes the job', async () => {
      const queued = await inScope('user-a', [EXPORT, GATED], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );
      if (!queued.ok) throw new Error('expected a job');

      const generated = await inScope(undefined, [], () => service.generate(queued.value.id));
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;
      expect(writtenColumns).toEqual(['number', 'name', 'nik']);
      expect(generated.value).toMatchObject({ status: 'completed', rowCount: 2 });
      expect(generated.value.fileId).not.toBeNull();
    });

    it('§9: a permission revoked after enqueue does not narrow the file', async () => {
      const queued = await inScope('user-a', [EXPORT, GATED], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );
      if (!queued.ok) throw new Error('expected a job');

      // The generator runs with no request permissions at all — a worker has
      // none — and the file still matches what the requester could see.
      await inScope(undefined, [], () => service.generate(queued.value.id));
      expect(writtenColumns).toContain('nik');
    });

    it('parks the output under the export job so BR-IMP-010’s owner can resolve it', async () => {
      const queued = await inScope('user-a', [EXPORT], () =>
        service.enqueue('employee.master', { companyId: COMPANY }),
      );
      if (!queued.ok) throw new Error('expected a job');
      const generated = await inScope(undefined, [], () => service.generate(queued.value.id));
      if (!generated.ok || !generated.value.fileId) throw new Error('expected a file');

      expect(documents.files.get(generated.value.fileId)).toMatchObject({
        category: 'import_file',
        entityType: 'export_job',
        entityId: queued.value.id,
      });
    });

    it('notifies the requester alone and emits export.completed', async () => {
      const job = jobs.seed({
        type: 'employee.master',
        params: { companyId: COMPANY, _columns: ['number'], _gated: false },
        requestedBy: 'user-a',
      });
      await inScope(undefined, [], () => service.generate(job.id));

      expect(sent).toEqual([
        expect.objectContaining({
          templateKey: 'import-export.export_finished',
          recipients: { kind: 'users', userIds: ['user-a'] },
        }),
      ]);
      // §5: the link is the job page and never a signed URL — TTL hygiene.
      expect(sent[0]?.deepLink).toBeUndefined();
      expect(emitted[0]).toMatchObject({
        name: 'import-export.export.completed',
        payload: { jobId: job.id, type: 'employee.master', rowCount: 2 },
      });
    });

    it('is idempotent: a redelivered generate returns the completed job untouched', async () => {
      const job = jobs.seed({
        type: 'employee.master',
        status: 'completed',
        fileId: 'file-x',
        rowCount: 9,
      });
      const generated = await inScope(undefined, [], () => service.generate(job.id));
      expect(generated.ok).toBe(true);
      if (generated.ok) expect(generated.value).toMatchObject({ fileId: 'file-x', rowCount: 9 });
      expect(documents.written.size).toBe(0);
    });

    it('drops a frozen column the definition no longer declares', async () => {
      const job = jobs.seed({
        type: 'employee.master',
        params: { companyId: COMPANY, _columns: ['number', 'retired', 'name'], _gated: false },
      });
      await inScope(undefined, [], () => service.generate(job.id));
      expect(writtenColumns).toEqual(['number', 'name']);
    });

    it('fails the job when the writer throws, and records a SYS-class code', async () => {
      const job = jobs.seed({
        type: 'employee.master',
        params: { companyId: COMPANY, _columns: ['number'], _gated: false },
      });
      documents.storeGenerated = () => Promise.reject(new Error('bucket down'));

      const generated = await inScope(undefined, [], () => service.generate(job.id));
      expect(generated.ok).toBe(true);
      if (generated.ok) {
        expect(generated.value).toMatchObject({ status: 'failed', failureCode: 'SYS_INTERNAL' });
      }
    });
  });
});
