import { AppError } from '../../../shared/app-error';
import { fail, ok, type Result } from '../../../shared/result';
import type { NotificationPort, SendCommand } from '../../notification';
import type { SettingsPort } from '../../settings';
import { clearDefinitions, registerImportDefinition } from '../domain/definitions';
import type {
  ImportExportOutboxPort,
  ParsedWorkbook,
  WorkbookReaderPort,
  WorkbookWriterPort,
} from '../domain/import-export.ports';
import type { ParsedRow } from '../domain/import-export.types';
import { CommitImportService, COMMIT_BATCH_SIZE } from './commit-import.service';
import { RowValidationService } from './row-validation.service';
import {
  clock,
  TENANT,
  FakeDocuments,
  FakeImportJobs,
  importDefinition,
  inScope,
  savepointing,
} from './test-support';
import type { ConnectionProvider } from '../../../database/connection.provider';

function row(rowNumber: number, nik: string): [number, ...unknown[]] {
  return [rowNumber, nik, `Name ${nik}`, '2026-01-05'];
}

describe('CommitImportService — UC-IMP-003', () => {
  let jobs: FakeImportJobs;
  let documents: FakeDocuments;
  let sent: SendCommand[];
  let emitted: Parameters<ImportExportOutboxPort['emit']>[0][];
  let sheet: [number, ...unknown[]][];
  let applied: ParsedRow[];
  let refuse: (row: ParsedRow) => Result<void> | null;

  function build(overrides: Parameters<typeof importDefinition>[0] = {}) {
    clearDefinitions();
    registerImportDefinition(
      importDefinition({
        rowHandler: {
          apply: (parsed) => {
            const refused = refuse(parsed);
            if (refused) return Promise.resolve(refused);
            applied.push(parsed);
            return Promise.resolve(ok(undefined));
          },
        },
        ...overrides,
      }),
    );

    const reader: WorkbookReaderPort = {
      read: () =>
        Promise.resolve(
          ok<ParsedWorkbook>({
            templateVersion: 1,
            headers: ['NIK', 'Nama', 'Tanggal masuk'],
            rows: sheet.map(([rowNumber, ...cells]) => ({ rowNumber, cells })),
          }),
        ),
    };
    const writer: Pick<WorkbookWriterPort, 'errorReport'> = {
      errorReport: (_input, sink) => {
        sink.write('errors');
        return Promise.resolve();
      },
    };

    return new CommitImportService(
      jobs,
      documents,
      reader,
      writer as WorkbookWriterPort,
      { resolve: () => Promise.resolve(10_000) } as unknown as SettingsPort,
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
      savepointing as unknown as ConnectionProvider,
      new RowValidationService(),
    );
  }

  beforeEach(() => {
    jobs = new FakeImportJobs();
    documents = new FakeDocuments();
    documents.content = Buffer.from('xlsx');
    sent = [];
    emitted = [];
    applied = [];
    refuse = () => null;
    sheet = [row(2, '3201'), row(3, '3202')];
  });

  function seedCommitting(overrides = {}) {
    return jobs.seed({ type: 'employee.master', status: 'committing', ...overrides });
  }

  it('applies every valid row and lands `completed`', async () => {
    const service = build();
    const job = seedCommitting();

    const committed = await inScope('user-a', [], () => service.commit(job.id));

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value).toMatchObject({ status: 'completed', appliedRows: 2, errorRows: 0 });
    expect(applied.map((parsed) => parsed.values.nik)).toEqual(['3201', '3202']);
  });

  it('emits import.committed with counts, as pointers only', async () => {
    const service = build();
    const job = seedCommitting();
    await inScope('user-a', [], () => service.commit(job.id));

    expect(emitted).toEqual([
      {
        name: 'import-export.import.committed',
        // The event carries the request's tenant; the id itself is the fixture's.
        tenantId: TENANT,
        aggregateId: job.id,
        payload: { jobId: job.id, type: 'employee.master', appliedRows: 2, errorRows: 0 },
      },
    ]);
  });

  it('§13: notifies the requester and the confirmer, once, when they differ', async () => {
    const service = build();
    const job = seedCommitting({ requestedBy: 'user-a', confirmedBy: 'user-b' });
    await inScope('user-a', [], () => service.commit(job.id));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      templateKey: 'import-export.import_finished',
      recipients: { kind: 'users', userIds: ['user-a', 'user-b'] },
      params: { importType: 'employee.master', applied: 2, failed: 0 },
      dedupeKey: `import-export.import_finished:${job.id}`,
    });
  });

  it('collapses requester and confirmer into one recipient when they are the same person', async () => {
    const service = build();
    const job = seedCommitting({ requestedBy: 'user-a', confirmedBy: 'user-a' });
    await inScope('user-a', [], () => service.commit(job.id));
    expect(sent[0]?.recipients).toEqual({ kind: 'users', userIds: ['user-a'] });
  });

  describe('BR-IMP-003 — partial', () => {
    it('applies the good rows and reports the bad, landing partially_completed', async () => {
      const service = build();
      sheet = [row(2, '3201'), [3, '', 'Siti', '2026-01-05'], row(4, '3203')];
      const job = seedCommitting();

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.value).toMatchObject({
        status: 'partially_completed',
        appliedRows: 2,
        errorRows: 1,
      });
      expect(applied).toHaveLength(2);
    });

    it('skips a row the handler refuses and keeps going — never a batch rollback', async () => {
      const service = build();
      refuse = (parsed) =>
        parsed.values.nik === '3202' ? fail(new AppError('PAY_SALARY_OVERLAP')) : null;
      const job = seedCommitting();

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.value).toMatchObject({
        status: 'partially_completed',
        appliedRows: 1,
        errorRows: 1,
      });
    });

    it('records a handler that throws as one row’s failure rather than the job’s', async () => {
      const service = build();
      refuse = (parsed) => {
        if (parsed.values.nik === '3201') throw new Error('constraint blew up');
        return null;
      };
      const job = seedCommitting();

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (committed.ok) expect(committed.value.appliedRows).toBe(1);
    });

    it('attaches a final error workbook regenerated from commit-time verdicts', async () => {
      const service = build();
      sheet = [row(2, '3201'), [3, '', 'Siti', '2026-01-05']];
      const job = seedCommitting({ errorReportFileId: 'stale-report' });

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (committed.ok) expect(committed.value.errorReportFileId).not.toBe('stale-report');
    });
  });

  describe('BR-IMP-003 — strict', () => {
    it('writes nothing and fails the whole job on any verdict', async () => {
      const service = build({ commitMode: 'strict' });
      sheet = [row(2, '3201'), [3, '', 'Siti', '2026-01-05']];
      const job = seedCommitting();

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.value).toMatchObject({ status: 'failed', appliedRows: 0, errorRows: 1 });
      expect(applied).toEqual([]);
    });

    it('completes a strict job whose rows are all clean', async () => {
      const service = build({ commitMode: 'strict' });
      const job = seedCommitting();
      const committed = await inScope('user-a', [], () => service.commit(job.id));
      if (committed.ok) expect(committed.value.status).toBe('completed');
      expect(applied).toHaveLength(2);
    });
  });

  describe('BR-IMP-004 — batches and the resume cursor', () => {
    it('advances last_committed_batch once per batch', async () => {
      const service = build();
      sheet = Array.from({ length: COMMIT_BATCH_SIZE + 5 }, (_, index) =>
        row(index + 2, `nik-${index}`),
      );
      const job = seedCommitting();

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      expect(committed.ok).toBe(true);
      if (committed.ok) expect(committed.value.lastCommittedBatch).toBe(1);
      expect(applied).toHaveLength(COMMIT_BATCH_SIZE + 5);
    });

    it('§14: a redelivery resumes after the last durable batch and applies no row twice', async () => {
      const service = build();
      sheet = Array.from({ length: COMMIT_BATCH_SIZE + 5 }, (_, index) =>
        row(index + 2, `nik-${index}`),
      );
      const job = seedCommitting({ lastCommittedBatch: 0, appliedRows: COMMIT_BATCH_SIZE });

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      // Batch 0 was already durable, so only the tail is re-applied — and the
      // count still reports every row that landed across both attempts.
      expect(applied).toHaveLength(5);
      if (committed.ok) expect(committed.value.appliedRows).toBe(COMMIT_BATCH_SIZE + 5);
    });

    it('carries the previous attempt’s count forward rather than assuming a full batch', async () => {
      const service = build();
      sheet = Array.from({ length: COMMIT_BATCH_SIZE + 5 }, (_, index) =>
        row(index + 2, `nik-${index}`),
      );
      // The first attempt applied 195 of 200 and persisted that. Counting the
      // skipped batch as full would report five writes that never happened.
      const job = seedCommitting({ lastCommittedBatch: 0, appliedRows: COMMIT_BATCH_SIZE - 5 });

      const committed = await inScope('user-a', [], () => service.commit(job.id));
      if (committed.ok) expect(committed.value.appliedRows).toBe(COMMIT_BATCH_SIZE);
    });
  });

  it('retires the dry-run’s workbook when the commit-time one supersedes it', async () => {
    const service = build();
    sheet = [row(2, '3201'), [3, '', 'Siti', '2026-01-05']];
    const job = seedCommitting({ errorReportFileId: 'dry-run-report' });

    await inScope('user-a', [], () => service.commit(job.id));
    // §12's purge collects a job's two file ids; a report the job no longer
    // references would otherwise outlive the job itself.
    expect(documents.softDeleted).toEqual(['dry-run-report']);
  });

  it('retires nothing when there was no earlier workbook to supersede', async () => {
    const service = build();
    sheet = [row(2, '3201'), [3, '', 'Siti', '2026-01-05']];
    await inScope('user-a', [], () => service.commit(seedCommitting().id));
    expect(documents.softDeleted).toEqual([]);
  });

  it('refuses to commit a job that is not in `committing`', async () => {
    const service = build();
    const job = jobs.seed({ type: 'employee.master', status: 'awaiting_confirmation' });
    const committed = await inScope('user-a', [], () => service.commit(job.id));
    expect(committed.ok).toBe(false);
    expect(applied).toEqual([]);
  });

  it('fails the job when its file can no longer be read', async () => {
    const service = build();
    documents.content = null;
    const job = seedCommitting();

    const committed = await inScope('user-a', [], () => service.commit(job.id));
    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.value).toMatchObject({
        status: 'failed',
        failureCode: 'IMP_FILE_UNREADABLE',
      });
    }
  });
});
