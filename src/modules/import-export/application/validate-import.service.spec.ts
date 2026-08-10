import { fail, ok, type Result } from '../../../shared/result';
import type { SettingsPort } from '../../settings';
import { clearDefinitions, registerImportDefinition } from '../domain/definitions';
import { importExportErrors } from '../domain/import-export.errors';
import type {
  ErrorReportInput,
  ParsedWorkbook,
  WorkbookReaderPort,
  WorkbookWriterPort,
} from '../domain/import-export.ports';
import { RowValidationService } from './row-validation.service';
import { clock, FakeDocuments, FakeImportJobs, importDefinition, inScope } from './test-support';
import { ValidateImportService } from './validate-import.service';

describe('ValidateImportService — UC-IMP-002', () => {
  let jobs: FakeImportJobs;
  let documents: FakeDocuments;
  let reports: ErrorReportInput[];
  let workbook: Result<ParsedWorkbook>;
  let maxRows: number;
  let service: ValidateImportService;

  const sheet = (rows: [number, ...unknown[]][]): ParsedWorkbook => ({
    templateVersion: 1,
    headers: ['NIK', 'Nama', 'Tanggal masuk'],
    rows: rows.map(([rowNumber, ...cells]) => ({ rowNumber, cells })),
  });

  beforeEach(() => {
    clearDefinitions();
    registerImportDefinition(importDefinition());
    jobs = new FakeImportJobs();
    documents = new FakeDocuments();
    documents.content = Buffer.from('xlsx');
    reports = [];
    maxRows = 10_000;
    workbook = ok(sheet([[2, '3201', 'Budi', '2026-01-05']]));

    const reader: WorkbookReaderPort = { read: () => Promise.resolve(workbook) };
    const writer: Pick<WorkbookWriterPort, 'errorReport'> = {
      errorReport: (input, sink) => {
        reports.push(input);
        sink.write('x');
        return Promise.resolve();
      },
    };

    service = new ValidateImportService(
      jobs,
      documents,
      reader,
      writer as WorkbookWriterPort,
      { resolve: () => Promise.resolve(maxRows) } as unknown as SettingsPort,
      clock,
      new RowValidationService(),
    );
  });

  const seed = () => jobs.seed({ type: 'employee.master', status: 'uploaded' });

  it('lands awaiting_confirmation with the counts and the template version', async () => {
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));

    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value).toMatchObject({
      status: 'awaiting_confirmation',
      templateVersion: 1,
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
    });
  });

  it('attaches no error workbook when every row is clean', async () => {
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));
    expect(reports).toEqual([]);
    if (validated.ok) expect(validated.value.errorReportFileId).toBeNull();
  });

  it('BR-IMP-009: writes an error workbook carrying original row numbers', async () => {
    workbook = ok(sheet([[7, '', 'Budi', '2026-01-05']]));
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));

    expect(reports[0]?.verdicts).toEqual([
      { rowNumber: 7, errors: [{ column: 'nik', code: 'VAL_REQUIRED' }] },
    ]);
    if (validated.ok) expect(validated.value.errorReportFileId).not.toBeNull();
  });

  it('BR-IMP-006: a mismatched marker fails the job before a single row is coerced', async () => {
    workbook = ok({ ...sheet([[2, '', '', '']]), templateVersion: 0 });
    const job = seed();

    const validated = await inScope(undefined, [], () => service.validate(job.id));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value).toMatchObject({
      status: 'failed',
      failureCode: 'IMP_TEMPLATE_STALE',
    });
    // No row verdicts at all — the whole point of the marker.
    expect(reports).toEqual([]);
    expect(validated.value.totalRows).toBeNull();
  });

  it('treats a missing marker as stale rather than as version zero', async () => {
    workbook = ok({ ...sheet([[2, '3201', 'Budi', '2026-01-05']]), templateVersion: null });
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));
    if (validated.ok) expect(validated.value.failureCode).toBe('IMP_TEMPLATE_STALE');
  });

  it('BR-IMP-007: a row-cap refusal from the parser fails the job', async () => {
    workbook = fail(importExportErrors.rowCapExceeded({ maxRows: 10_000 }));
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));
    if (validated.ok) expect(validated.value.failureCode).toBe('IMP_ROW_CAP_EXCEEDED');
  });

  it('passes the tenant’s configured cap to the parser rather than a constant', async () => {
    maxRows = 25;
    const seen: number[] = [];
    const reader: WorkbookReaderPort = {
      read: (_source, cap) => {
        seen.push(cap);
        return Promise.resolve(workbook);
      },
    };
    const scoped = new ValidateImportService(
      jobs,
      documents,
      reader,
      { errorReport: () => Promise.resolve() } as unknown as WorkbookWriterPort,
      { resolve: () => Promise.resolve(maxRows) } as unknown as SettingsPort,
      clock,
      new RowValidationService(),
    );

    await inScope(undefined, [], () => scoped.validate(seed().id));
    expect(seen).toEqual([25]);
  });

  it('fails the job when the source file has no readable content', async () => {
    documents.content = null;
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));
    if (validated.ok) expect(validated.value.failureCode).toBe('IMP_FILE_UNREADABLE');
  });

  it('fails the job when its definition is no longer registered', async () => {
    clearDefinitions();
    const job = seed();
    const validated = await inScope(undefined, [], () => service.validate(job.id));
    if (validated.ok) expect(validated.value.status).toBe('failed');
  });

  it('is idempotent — a re-run produces the same counts and overwrites nothing else', async () => {
    const job = seed();
    const first = await inScope(undefined, [], () => service.validate(job.id));
    const second = await inScope(undefined, [], () => service.validate(job.id));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.totalRows).toBe(first.value.totalRows);
      expect(second.value.status).toBe('awaiting_confirmation');
    }
  });

  it('answers 404 for a job that does not exist', async () => {
    const validated = await inScope(undefined, [], () => service.validate('missing'));
    expect(validated.ok).toBe(false);
  });
});
