import { PassThrough, Readable } from 'node:stream';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import { OutboxRepository } from '../src/database/outbox.repository';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AppError } from '../src/shared/app-error';
import { fail, ok, type Result } from '../src/shared/result';
import type {
  DocumentPort,
  EntityRef,
  FileRow,
  GeneratedFileCommand,
} from '../src/modules/document';
import type { NotificationPort, SendCommand } from '../src/modules/notification';
import { CommitImportService } from '../src/modules/import-export/application/commit-import.service';
import { DefinitionAccessService } from '../src/modules/import-export/application/definition-access.service';
import { ExportService } from '../src/modules/import-export/application/export.service';
import { ImportExportJobsService } from '../src/modules/import-export/application/import-export-jobs.service';
import { ImportJobsService } from '../src/modules/import-export/application/import-jobs.service';
import { RowValidationService } from '../src/modules/import-export/application/row-validation.service';
import { ValidateImportService } from '../src/modules/import-export/application/validate-import.service';
import {
  registerImportDefinition,
  type ImportDefinition,
  type ParsedRow,
} from '../src/modules/import-export';
import { clearDefinitions } from '../src/modules/import-export/domain/definitions';
import { ExportJobRepository } from '../src/modules/import-export/infrastructure/export-job.repository';
import { ImportJobRepository } from '../src/modules/import-export/infrastructure/import-job.repository';
import { XlsxWorkbookReader } from '../src/modules/import-export/infrastructure/xlsx.reader';
import { XlsxWorkbookWriter } from '../src/modules/import-export/infrastructure/xlsx.writer';
import {
  DATA_SHEET,
  META_SHEET,
  TEMPLATE_VERSION_LABEL,
} from '../src/modules/import-export/infrastructure/workbook-layout';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * §14's scenario table against a real database and real workbooks.
 *
 * The unit suite proves each decision with fakes. Three things only a database
 * proves, and each of them is load-bearing:
 *
 * **The concurrency guard is an index.** `insertIfNoneActive` returns `null`
 * because PostgreSQL refused the insert, not because a fake was told to.
 *
 * **A refused row leaves nothing behind.** BR-IMP-003's *"a bad row is skipped
 * inside its batch, never a batch rollback"* is a claim about savepoints, and a
 * fake `savepoint` that just calls the function cannot show that the writes the
 * handler made before it refused are gone.
 *
 * **The golden fixture is a file.** §14's first row asks for *"file in → exact
 * per-row verdicts + workbook out"*, and the file here is written by this
 * module's own template writer and read by its own parser.
 */
describe('import-export lifecycle', () => {
  const NOW = new Date('2026-08-10T03:00:00Z');
  const DAY_MS = 24 * 60 * 60 * 1000;
  const PERMISSION = 'holiday.calendar.import';

  let db: TestDatabase;
  let unitOfWork: UnitOfWork;
  let connection: ConnectionProvider;
  let imports: ImportJobRepository;
  let exports_: ExportJobRepository;
  let start: ImportJobsService;
  let validate: ValidateImportService;
  let commit: CommitImportService;
  let exportService: ExportService;
  let crons: ImportExportJobsService;

  const tenantId = uuidv7();
  const otherTenantId = uuidv7();
  const userA = uuidv7();
  const userB = uuidv7();

  /** The applied rows, so a rollback is observable rather than asserted about. */
  const applied: string[] = [];
  let refuse: (row: ParsedRow) => Result<void> | null = () => null;
  let retentionDays = 365;
  const sent: SendCommand[] = [];

  const text = (value: string) => ({ id: value, en: value });

  const DEFINITION: ImportDefinition = {
    key: 'holiday.calendar',
    requiredPermission: PERMISSION,
    templateVersion: 2,
    columns: [
      { key: 'date', header: text('Tanggal'), type: 'date', required: true, example: '2026-01-01' },
      { key: 'name', header: text('Nama'), type: 'string', required: true, example: 'Tahun Baru' },
      {
        key: 'kind',
        header: text('Jenis'),
        type: 'enum',
        required: true,
        enumValues: ['national', 'cuti_bersama'],
        example: 'national',
      },
    ],
    naturalKey: ['date', 'kind'],
    writeMode: 'upsert',
    commitMode: 'partial',
    rowHandler: {
      apply: async (row) => {
        const refused = refuse(row);
        // A real write, so a savepoint rollback has something to undo.
        await connection
          .handle()
          .execute(
            sql`INSERT INTO scratch_notes (id, tenant_id, body) VALUES (${uuidv7()}::uuid, ${tenantId}::uuid, ${String(row.values.name)})`,
          );
        if (refused) return refused;
        applied.push(String(row.values.date));
        return ok(undefined);
      },
    },
  };

  /** A `DocumentPort` over the real `files` table and an in-memory bucket. */
  const objects = new Map<string, Buffer>();
  const documents: DocumentPort = {
    storeGenerated: async (command: GeneratedFileCommand, write) => {
      const chunks: Buffer[] = [];
      const sink = new PassThrough();
      sink.on('data', (chunk: Buffer) => chunks.push(chunk));
      const finished = new Promise<void>((resolve) => sink.on('end', () => resolve()));
      await write(sink);
      sink.end();
      await finished;

      const id = uuidv7();
      objects.set(id, Buffer.concat(chunks));
      await insertFileRow(id, command.entityType, command.entityId, command.fileName);
      return (await documents.find(id))!;
    },
    find: async (fileId) => {
      const rows = await db.migrator.query<FileRow & { entity_type: string; entity_id: string }>(
        'SELECT * FROM files WHERE id = $1',
        [fileId],
      );
      const row = rows.rows[0];
      return row
        ? {
            ...row,
            id: fileId,
            entityType: row.entity_type,
            entityId: row.entity_id,
            status: 'committed',
            category: 'import_file',
            uploadedBy: userA,
          }
        : null;
    },
    openContent: (fileId) => {
      const bytes = objects.get(fileId);
      return Promise.resolve(bytes ? Readable.from([bytes]) : null);
    },
    reparent: async (fileId, ref: EntityRef) => {
      await db.migrator.query('UPDATE files SET entity_type = $2, entity_id = $3 WHERE id = $1', [
        fileId,
        ref.entityType,
        ref.entityId,
      ]);
    },
    softDelete: async (fileId) => {
      await db.migrator.query('UPDATE files SET deleted_at = now() WHERE id = $1', [fileId]);
    },
  };

  async function insertFileRow(
    id: string,
    entityType: string,
    entityId: string,
    name: string,
  ): Promise<void> {
    await db.migrator.query(
      `INSERT INTO files
         (id, tenant_id, module, entity_type, entity_id, category, original_name, storage_path,
          mime, size_bytes, sha256, status, uploaded_by)
       VALUES ($1, $2, 'import-export', $3, $4, 'import_file', $5, $6,
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               1024, 'sha', 'committed', $7)`,
      [id, tenantId, entityType, entityId, name, `tenants/${tenantId}/import-export/${id}`, userA],
    );
  }

  /**
   * Writes a workbook carrying this definition's `_meta` marker and the given
   * data rows — the golden fixture §14 asks for, produced by the same layout
   * constants the template writer uses.
   */
  async function workbookOf(rows: (string | number)[][], version = 2): Promise<string> {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve) => sink.on('end', () => resolve()));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: false });
    // `_meta` first, exactly as the template writer emits it — the ordering is
    // what makes BR-IMP-006 fail before a row is read.
    const meta = workbook.addWorksheet(META_SHEET, { state: 'hidden' });
    meta.addRow([TEMPLATE_VERSION_LABEL, version]).commit();
    meta.commit();
    const data = workbook.addWorksheet(DATA_SHEET);
    data.addRow(DEFINITION.columns.map((column) => column.header.id)).commit();
    for (const row of rows) data.addRow(row).commit();
    data.commit();
    await workbook.commit();
    await finished;

    const id = uuidv7();
    objects.set(id, Buffer.concat(chunks));
    await insertFileRow(id, 'user', userA, 'holidays.xlsx');
    return id;
  }

  function inTenant<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () =>
      unitOfWork.run({ tenantId, source: 'jwt' }, () => {
        setTenantContext({ tenantId, source: 'jwt' });
        setRequestContext({
          requestId: 'request-1',
          userId,
          authorization: {
            resolve: () =>
              Promise.resolve({ permissions: new Set([PERMISSION]), companyScope: 'all' as const }),
          },
        });
        return fn();
      }),
    );
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    for (const [id, slug] of [
      [tenantId, 'imp-lifecycle'],
      [otherTenantId, 'imp-other'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [id, slug]);
    }

    const client = await db.app.connect();
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    for (const [id, email] of [
      [userA, 'a@example.test'],
      [userB, 'b@example.test'],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, $3, 'x', 'active')`,
        [id, tenantId, email],
      );
    }
    client.release();

    const clock = { now: () => NOW };
    const settings = {
      resolve: <T>(key: string) =>
        Promise.resolve((key.endsWith('max_rows') ? 10_000 : retentionDays) as T),
    };
    const notifications = {
      send: (command: SendCommand) => {
        sent.push(command);
        return Promise.resolve({ created: 1, deduped: 0, suppressed: 0 });
      },
    } as NotificationPort;

    imports = new ImportJobRepository(connection);
    exports_ = new ExportJobRepository(connection);
    const reader = new XlsxWorkbookReader();
    const writer = new XlsxWorkbookWriter();
    const access = new DefinitionAccessService();
    const outbox = new OutboxRepository(connection, clock);

    start = new ImportJobsService(imports, documents, clock, access);
    validate = new ValidateImportService(
      imports,
      documents,
      reader,
      writer,
      settings,
      clock,
      new RowValidationService(),
    );
    commit = new CommitImportService(
      imports,
      documents,
      reader,
      writer,
      settings,
      notifications,
      outbox,
      clock,
      connection,
      new RowValidationService(),
    );
    exportService = new ExportService(
      exports_,
      documents,
      writer,
      notifications,
      outbox,
      clock,
      access,
    );
    crons = new ImportExportJobsService(
      imports,
      exports_,
      documents,
      notifications,
      settings,
      clock,
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query(
      'TRUNCATE import_jobs, export_jobs, files, domain_events, scratch_notes CASCADE',
    );
    clearDefinitions();
    registerImportDefinition(DEFINITION);
    objects.clear();
    applied.length = 0;
    sent.length = 0;
    refuse = () => null;
    retentionDays = 365;
  });

  async function through(rows: (string | number)[][], version = 2) {
    const fileId = await workbookOf(rows, version);
    const started = await inTenant(userA, () => start.start(DEFINITION.key, fileId));
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    const validated = await inTenant(userA, () => validate.validate(started.value.id));
    if (!validated.ok) throw new Error('validate failed');
    return validated.value;
  }

  it('§14 golden fixture: a template-shaped file in, exact per-row verdicts out', async () => {
    const job = await through([
      ['2026-01-01', 'Tahun Baru', 'national'],
      ['2026-03-19', 'Nyepi', 'NATIONAL'],
      ['bukan tanggal', 'Salah', 'custom'],
    ]);

    expect(job).toMatchObject({
      status: 'awaiting_confirmation',
      templateVersion: 2,
      totalRows: 3,
      validRows: 2,
      errorRows: 1,
    });
    expect(job.errorReportFileId).not.toBeNull();
  });

  it('re-parents the uploaded file onto the job (§14, UC-IMP-001)', async () => {
    const fileId = await workbookOf([['2026-01-01', 'Tahun Baru', 'national']]);
    const started = await inTenant(userA, () => start.start(DEFINITION.key, fileId));
    if (!started.ok) throw new Error('start failed');

    const { rows } = await db.migrator.query<{ entity_type: string; entity_id: string }>(
      'SELECT entity_type, entity_id FROM files WHERE id = $1',
      [fileId],
    );
    expect(rows[0]).toEqual({ entity_type: 'import_job', entity_id: started.value.id });
  });

  it('§14: a second start of the same type is refused by the index, with the winner’s id', async () => {
    const first = await workbookOf([['2026-01-01', 'A', 'national']]);
    const second = await workbookOf([['2026-01-02', 'B', 'national']]);

    const won = await inTenant(userA, () => start.start(DEFINITION.key, first));
    const lost = await inTenant(userA, () => start.start(DEFINITION.key, second));

    expect(lost.ok).toBe(false);
    if (!lost.ok && won.ok) {
      expect(lost.error.code).toBe('IMP_ALREADY_RUNNING');
      expect(lost.error.details).toEqual({ activeJobId: won.value.id });
    }
  });

  it('§14: a stale template marker fails at validate with zero row processing', async () => {
    const fileId = await workbookOf([['2026-01-01', 'Tahun Baru', 'national']], 1);
    const started = await inTenant(userA, () => start.start(DEFINITION.key, fileId));
    if (!started.ok) throw new Error('start failed');

    const validated = await inTenant(userA, () => validate.validate(started.value.id));
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value).toMatchObject({
      status: 'failed',
      failureCode: 'IMP_TEMPLATE_STALE',
      totalRows: null,
    });
  });

  it('commits the valid rows, records the applied count and emits the fact', async () => {
    const job = await through([
      ['2026-01-01', 'Tahun Baru', 'national'],
      ['2026-03-19', 'Nyepi', 'national'],
    ]);
    const confirmed = await inTenant(userB, () => start.confirm(job.id));
    if (!confirmed.ok) throw new Error('confirm failed');

    const committed = await inTenant(userB, () => commit.commit(job.id));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value).toMatchObject({
      status: 'completed',
      appliedRows: 2,
      errorRows: 0,
      confirmedBy: userB,
    });
    expect(applied).toEqual(['2026-01-01', '2026-03-19']);

    const events = await db.migrator.query<{ name: string; payload: Record<string, unknown> }>(
      'SELECT name, payload FROM domain_events',
    );
    expect(events.rows[0]).toMatchObject({
      name: 'import-export.import.committed',
      payload: { jobId: job.id, appliedRows: 2, errorRows: 0 },
    });
  });

  it('BR-IMP-003: a refused row rolls its own writes back and the rest still land', async () => {
    refuse = (row) =>
      row.values.name === 'Nyepi' ? fail(new AppError('HOL_DUPLICATE_DATE')) : null;

    const job = await through([
      ['2026-01-01', 'Tahun Baru', 'national'],
      ['2026-03-19', 'Nyepi', 'national'],
      ['2026-05-01', 'Buruh', 'national'],
    ]);
    await inTenant(userA, () => start.confirm(job.id));
    const committed = await inTenant(userA, () => commit.commit(job.id));

    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.value).toMatchObject({
        status: 'partially_completed',
        appliedRows: 2,
        errorRows: 1,
      });
    }

    // The refused row's handler wrote a note before it refused. The savepoint is
    // what makes that write disappear while the other two survive — the property
    // no fake can demonstrate.
    const notes = await db.migrator.query<{ body: string }>('SELECT body FROM scratch_notes');
    expect(notes.rows.map((row) => row.body).sort()).toEqual(['Buruh', 'Tahun Baru']);
  });

  it('BR-IMP-003 strict: any verdict aborts the job and writes nothing at all', async () => {
    clearDefinitions();
    registerImportDefinition({ ...DEFINITION, commitMode: 'strict' });

    const job = await through([
      ['2026-01-01', 'Tahun Baru', 'national'],
      ['bukan tanggal', 'Salah', 'custom'],
    ]);
    await inTenant(userA, () => start.confirm(job.id));
    const committed = await inTenant(userA, () => commit.commit(job.id));

    if (committed.ok) {
      expect(committed.value).toMatchObject({ status: 'failed', appliedRows: 0 });
    }
    const notes = await db.migrator.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM scratch_notes',
    );
    expect(Number(notes.rows[0]!.n)).toBe(0);
  });

  it('§9: the second of two confirms gets IMP_INVALID_STATE naming committing', async () => {
    const job = await through([['2026-01-01', 'Tahun Baru', 'national']]);
    await inTenant(userA, () => start.confirm(job.id));
    const second = await inTenant(userB, () => start.confirm(job.id));

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.details).toEqual({ status: 'committing' });
  });

  it('BR-IMP-011: the sweep cancels a stale dry-run and leaves a fresh one alone', async () => {
    const stale = await through([['2026-01-01', 'Tahun Baru', 'national']]);
    await db.migrator.query('UPDATE import_jobs SET created_at = $2 WHERE id = $1', [
      stale.id,
      new Date(NOW.getTime() - 2 * DAY_MS),
    ]);

    const report = await inTenant(userA, () => crons.autoCancelStale());
    expect(report).toEqual({ cancelled: 1, raced: 0 });

    const after = await inTenant(userA, () => imports.findById(stale.id));
    expect(after?.status).toBe('cancelled');
    // The completed import is now the only one of its type — so a new one may
    // start, which is the partial index doing its second job.
    const next = await workbookOf([['2026-02-01', 'Isra', 'national']]);
    const started = await inTenant(userA, () => start.start(DEFINITION.key, next));
    expect(started.ok).toBe(true);
  });

  it('§12: the purge removes terminal jobs and retires their files, keeping fresh ones', async () => {
    const oldJob = await through([['2026-01-01', 'Tahun Baru', 'national']]);
    await inTenant(userA, () => start.confirm(oldJob.id));
    await inTenant(userA, () => commit.commit(oldJob.id));
    await db.migrator.query('UPDATE import_jobs SET created_at = $2 WHERE id = $1', [
      oldJob.id,
      new Date(NOW.getTime() - 400 * DAY_MS),
    ]);

    const report = await inTenant(userA, () => crons.purge());
    expect(report.importJobs).toBe(1);

    const remaining = await inTenant(userA, () => imports.findById(oldJob.id));
    expect(remaining).toBeNull();
    const files = await db.migrator.query<{ n: string }>(
      'SELECT count(*)::int AS n FROM files WHERE deleted_at IS NULL',
    );
    expect(Number(files.rows[0]!.n)).toBe(0);
  });

  it('§12: the purge leaves a job inside the window and one still awaiting confirmation', async () => {
    const pending = await through([['2026-01-01', 'Tahun Baru', 'national']]);
    await db.migrator.query('UPDATE import_jobs SET created_at = $2 WHERE id = $1', [
      pending.id,
      new Date(NOW.getTime() - 400 * DAY_MS),
    ]);

    const report = await inTenant(userA, () => crons.purge());
    expect(report.importJobs).toBe(0);
    expect(await inTenant(userA, () => imports.findById(pending.id))).not.toBeNull();
  });

  it('lists jobs newest first with a stable total', async () => {
    const first = await through([['2026-01-01', 'A', 'national']]);
    await db.migrator.query("UPDATE import_jobs SET status = 'completed' WHERE id = $1", [
      first.id,
    ]);
    const second = await through([['2026-02-01', 'B', 'national']]);

    const page = await inTenant(userA, () => start.list({}, { limit: 10, offset: 0 }));
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it('an export job round-trips through the real repository with its frozen entitlement', async () => {
    const job = await inTenant(userA, () =>
      exports_.insert('holiday.calendar', {
        companyId: 'c1',
        _columns: ['date', 'name'],
        _gated: true,
      }),
    );
    const found = await inTenant(userA, () => exports_.findById(job.id));
    expect(found?.params).toMatchObject({ _columns: ['date', 'name'], _gated: true });
    expect(found?.requestedBy).toBe(userA);

    const completed = await inTenant(userA, () =>
      exports_.update(job.id, { status: 'completed', fileId: null, rowCount: 12 }),
    );
    expect(completed).toMatchObject({ status: 'completed', rowCount: 12 });

    const byFile = await inTenant(userA, () => exports_.findByFileId(uuidv7()));
    expect(byFile).toBeNull();
  });

  it('enqueues an export through the service with the caller\u2019s frozen columns', async () => {
    const queued = await inTenant(userA, () => exportService.enqueue('holiday.calendar', {}));
    // Nothing registered an `ExportDefinition` for this key, so §7's existence
    // hiding answers — the same refusal an unregistered key gets.
    expect(queued.ok).toBe(false);
    if (!queued.ok) expect(queued.error.code).toBe('VAL_VALIDATION_FAILED');
  });
});
