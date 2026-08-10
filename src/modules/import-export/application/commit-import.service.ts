import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConnectionProvider } from '../../../database/connection.provider';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { DOCUMENT_PORT, type DocumentPort } from '../../document';
import { NOTIFICATION_PORT, type NotificationPort } from '../../notification';
import { findImportDefinition, type ImportDefinition } from '../domain/definitions';
import { IMPORT_FILE_CATEGORY, jobEntityRef } from '../domain/file-refs';
import { failureCodes } from '../domain/import-export.errors';
import {
  IMPORT_EXPORT_OUTBOX,
  IMPORT_JOB_REPOSITORY,
  WORKBOOK_READER,
  WORKBOOK_WRITER,
  type ImportExportOutboxPort,
  type ImportJobRepositoryPort,
  type ParsedWorkbook,
  type WorkbookReaderPort,
  type WorkbookWriterPort,
} from '../domain/import-export.ports';
import type {
  ImportJobRow,
  ImportJobStatus,
  ParsedRow,
  RowError,
  RowVerdict,
} from '../domain/import-export.types';
import { DEFAULT_LOCALE } from '../domain/locale';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import { XLSX_MIME } from '../infrastructure/workbook-layout';
import { RowValidationService } from './row-validation.service';

/** BR-IMP-004 — *"batches of ~200 rows per transaction, sequentially"*. */
export const COMMIT_BATCH_SIZE = 200;

const MAX_ROWS_KEY = 'import-export.max_rows';

/**
 * UC-IMP-003's second half, the `import.commit:jobId` body.
 *
 * Three rules shape everything below and none of them is optional.
 *
 * **BR-IMP-002 — commit revalidates.** The dry-run's verdicts are not reused;
 * the file is parsed again and run through the same `RowValidationService`, so
 * the referent somebody deleted on Wednesday is caught on Thursday. *"Dry-run
 * informs, commit decides"* is a sentence about which of the two passes is
 * authoritative, and this is that pass.
 *
 * **BR-IMP-003 — the two commit modes.** `strict` aborts on any verdict and
 * writes nothing; `partial` applies what it can and reports the rest, and *"a
 * bad row is skipped inside its batch, never a batch rollback"*.
 *
 * **BR-IMP-004 — batches, resumable.** `last_committed_batch` advances after
 * each batch, so a redelivered job resumes rather than reapplying — which
 * matters because `apply` is the module's own write path and not every one of
 * them is naturally idempotent.
 */
@Injectable()
export class CommitImportService {
  private readonly logger = new Logger(CommitImportService.name);

  constructor(
    @Inject(IMPORT_JOB_REPOSITORY) private readonly jobs: ImportJobRepositoryPort,
    @Inject(DOCUMENT_PORT) private readonly documents: DocumentPort,
    @Inject(WORKBOOK_READER) private readonly reader: WorkbookReaderPort,
    @Inject(WORKBOOK_WRITER) private readonly writer: WorkbookWriterPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(IMPORT_EXPORT_OUTBOX) private readonly outbox: ImportExportOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly connection: ConnectionProvider,
    private readonly validation: RowValidationService,
  ) {}

  async commit(jobId: string): Promise<Result<ImportJobRow>> {
    const job = await this.jobs.findById(jobId);
    if (!job) return fail(sharedErrors.notFound());
    if (job.status !== 'committing') return fail(sharedErrors.notFound());

    const definition = findImportDefinition(job.type);
    if (!definition) return this.finish(job, 'failed', 0, [], null);

    const workbook = await this.parse(job.fileId);
    if (!workbook) return this.finish(job, 'failed', 0, [], failureCodes.fileUnreadable);

    // §9's *"definition version bumped while a job awaits confirmation"*: the
    // `_meta` marker is deliberately **not** re-checked here. The rule says
    // commit *"revalidates against the current definition; a column contract
    // change surfaces as row errors (or strict abort) — never a crash against a
    // stale shape"*, and re-raising `IMP_TEMPLATE_STALE` would be the job-level
    // refusal that rule rules out. BR-IMP-006's marker gate is an upload-time
    // gate, where UC-IMP-002 puts it.
    const pass = await this.validation.run(definition, workbook.rows);
    const verdicts = [...pass.report.verdicts];

    if (definition.commitMode === 'strict' && verdicts.length > 0) {
      // *"any failure at commit-revalidation aborts the whole job, nothing
      // written"* — and nothing has been written yet, because the apply loop has
      // not run. The abort is the absence of it.
      return this.finish(job, 'failed', 0, verdicts, null, definition, workbook);
    }

    const applied = await this.apply(job, definition, pass.validRows, verdicts);

    const status: ImportJobStatus = verdicts.length === 0 ? 'completed' : 'partially_completed';
    return this.finish(job, status, applied, verdicts, null, definition, workbook);
  }

  private async parse(fileId: string): Promise<ParsedWorkbook | null> {
    const content = await this.documents.openContent(fileId);
    if (!content) return null;
    const maxRows = await this.settings.resolve<number>(MAX_ROWS_KEY);
    const workbook = await this.reader.read(content, maxRows);
    return workbook.ok ? workbook.value : null;
  }

  /**
   * BR-IMP-004's loop.
   *
   * Every row's `apply` runs inside its own savepoint. That is not defensive
   * coding: a `rowHandler` refusing through a database constraint — which is
   * exactly how `payroll.salary_opening` refuses an employee who already holds a
   * package (ADR-0024) — aborts the enclosing transaction in PostgreSQL, and
   * without the savepoint the first such row would take every row after it. The
   * savepoint is what makes *"skipped inside its batch"* mechanically true.
   *
   * In strict mode the caller never reaches here with verdicts outstanding, so a
   * failure inside the loop is a bug rather than a refusal — it is recorded as a
   * row error and the job lands `partially_completed`, which §9 describes for
   * exactly this case: *"the error workbook + `appliedRows` state exactly what
   * landed"*.
   */
  private async apply(
    job: ImportJobRow,
    definition: ImportDefinition,
    rows: readonly ParsedRow[],
    verdicts: RowVerdict[],
  ): Promise<number> {
    const batches = chunk(rows, COMMIT_BATCH_SIZE);
    const resumeAfter = job.lastCommittedBatch ?? -1;
    // The count carries over from the previous attempt rather than being
    // recomputed as `batch.length` per skipped batch: a batch that applied 195 of
    // 200 rows persisted 195, and counting the skipped batch as full would report
    // five writes that never happened. `applied_rows` is the number the wizard
    // shows and the number the event carries, so it has to be the true one.
    let applied = resumeAfter >= 0 ? (job.appliedRows ?? 0) : 0;

    for (const [index, batch] of batches.entries()) {
      // A redelivered commit re-parses and re-validates from scratch — cheap and
      // deterministic — and skips the batches a previous attempt durably
      // applied. Re-running them would double every write the handler makes.
      //
      // What a resume cannot recover is the *verdicts* of the skipped batch's
      // failed rows: a handler refusal from the first attempt is not re-derived,
      // so the final workbook reports the rows this attempt refused. Row-level
      // state that is still wrong is caught anyway, by the `check` half of the
      // revalidation this commit already ran.
      if (index <= resumeAfter) continue;

      for (const row of batch) {
        const error = await this.applyRow(definition, row);
        if (error) {
          verdicts.push({ rowNumber: row.rowNumber, errors: [error] });
          continue;
        }
        applied += 1;
      }

      await this.jobs.update(job.id, { lastCommittedBatch: index, appliedRows: applied });
    }

    return applied;
  }

  private async applyRow(definition: ImportDefinition, row: ParsedRow): Promise<RowError | null> {
    try {
      return await this.connection.savepoint(async () => {
        const result = await definition.rowHandler.apply(row);
        if (result.ok) return null;
        // Rolling back the savepoint is what makes a refusal leave nothing
        // behind, even when the handler wrote before it decided. The error is
        // carried out through the throw and unwrapped by the caller.
        throw new RowRefused(result.error.code, result.error.details);
      });
    } catch (error) {
      if (error instanceof RowRefused) {
        return { column: null, code: error.code, params: error.params };
      }
      // §9: *"row handler throws unexpectedly (bug, not validation)"*. The
      // savepoint already rolled the row back; the job continues and the row is
      // reported, because the alternative is losing the other 9,999.
      this.logger.error(`import row ${row.rowNumber} of ${definition.key} threw: ${String(error)}`);
      return { column: null, code: failureCodes.internal };
    }
  }

  /**
   * The terminal transition, and the three things §5 attaches to it: the final
   * error workbook *"regenerated from commit-time verdicts (the authoritative
   * one)"*, the notification, and the `import-export.import.committed` event.
   */
  private async finish(
    job: ImportJobRow,
    status: ImportJobStatus,
    applied: number,
    verdicts: readonly RowVerdict[],
    failureCode: string | null,
    definition?: ImportDefinition,
    workbook?: ParsedWorkbook,
  ): Promise<Result<ImportJobRow>> {
    const replaced = definition && workbook && verdicts.length > 0;
    const errorReportFileId = replaced
      ? await this.writeErrorReport(job.id, definition, workbook, verdicts)
      : job.errorReportFileId;

    // The dry-run's workbook has just been superseded by *"the authoritative
    // one"*, and nothing else points at it. §12's purge collects a job's
    // `error_report_file_id` and its source, so a report the job no longer
    // references would outlive the job itself — retiring it here is what keeps
    // the purge's two file ids the whole set.
    if (replaced && job.errorReportFileId && job.errorReportFileId !== errorReportFileId) {
      await this.documents.softDelete(job.errorReportFileId);
    }

    const updated = await this.jobs.update(job.id, {
      status,
      appliedRows: applied,
      errorRows: verdicts.length,
      errorReportFileId,
      failureCode,
      completedAt: this.clock.now(),
    });
    if (!updated) return fail(sharedErrors.notFound());

    await this.notify(updated, applied, verdicts.length);

    // §12's fact, pointers only. Written to the outbox in the same transaction
    // as the writes it announces, which is the whole reason the outbox exists
    // (ADR-0010) — audit-log consumes it as a channel-2 headline.
    await this.outbox.emit({
      name: 'import-export.import.committed',
      tenantId: requireTenantContext().tenantId,
      aggregateId: updated.id,
      payload: {
        jobId: updated.id,
        type: updated.type,
        appliedRows: applied,
        errorRows: verdicts.length,
      },
    });
    return ok(updated);
  }

  private async writeErrorReport(
    jobId: string,
    definition: ImportDefinition,
    workbook: ParsedWorkbook,
    verdicts: readonly RowVerdict[],
  ): Promise<string> {
    const file = await this.documents.storeGenerated(
      {
        category: IMPORT_FILE_CATEGORY,
        ...jobEntityRef(jobId),
        fileName: `${definition.key}-errors.xlsx`,
        mime: XLSX_MIME,
      },
      (sink) =>
        this.writer.errorReport(
          {
            definition,
            locale: DEFAULT_LOCALE,
            headers: workbook.headers,
            rows: workbook.rows,
            verdicts,
          },
          sink,
        ),
    );
    return file.id;
  }

  /**
   * §13: *"audience: requester + confirmer when different"* — one send to both,
   * deduped by job id so a redelivered commit does not notify twice
   * (BR-NTF-004).
   */
  private async notify(job: ImportJobRow, applied: number, failed: number): Promise<void> {
    const userIds = [job.requestedBy, job.confirmedBy].filter(
      (id): id is string => typeof id === 'string',
    );
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return;

    await this.notifications.send({
      templateKey: 'import-export.import_finished',
      recipients: { kind: 'users', userIds: recipients },
      params: { importType: job.type, applied, failed },
      dedupeKey: `import-export.import_finished:${job.id}`,
    });
  }
}

/** Carries a handler's refusal out through the savepoint that must roll back. */
class RowRefused extends Error {
  constructor(
    readonly code: string,
    readonly params: Readonly<Record<string, unknown>> | undefined,
  ) {
    super(code);
  }
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push([...rows.slice(index, index + size)]);
  }
  return batches;
}
