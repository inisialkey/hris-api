import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { DOCUMENT_PORT, type DocumentPort } from '../../document';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import { findImportDefinition, type ImportDefinition } from '../domain/definitions';
import { IMPORT_FILE_CATEGORY, jobEntityRef } from '../domain/file-refs';
import { failureCodes, importExportErrors } from '../domain/import-export.errors';
import {
  IMPORT_JOB_REPOSITORY,
  WORKBOOK_READER,
  WORKBOOK_WRITER,
  type ImportJobRepositoryPort,
  type ParsedWorkbook,
  type WorkbookReaderPort,
  type WorkbookWriterPort,
} from '../domain/import-export.ports';
import type { ImportJobRow, Locale, RowVerdict } from '../domain/import-export.types';
import { DEFAULT_LOCALE } from '../domain/locale';
import { XLSX_MIME } from '../infrastructure/workbook-layout';
import { RowValidationService } from './row-validation.service';

/** BR-IMP-007's ceiling, resolved per tenant (settings §4.2, tighten-only). */
const MAX_ROWS_KEY = 'import-export.max_rows';

/**
 * UC-IMP-002, the `import.validate:jobId` body — *"streaming parse … zero
 * writes … counts + error workbook → `awaiting_confirmation`"*.
 *
 * **No schedule**, for the reason the approval SLA scan, the audit anchor, the
 * document sweeps and the notification purge have none: ADR-0010 dispatches this
 * from a BullMQ worker and this repository has none. The body is the part that
 * has to be right.
 *
 * **Idempotent** (§12): re-running regenerates the same verdicts from the same
 * file against the same definition, and the job row is overwritten rather than
 * appended to. A redelivery costs a second parse and changes nothing.
 *
 * §5 is explicit that the completion notification *"fires only at terminal
 * states, not here — the requester is watching the wizard"*, which is why
 * nothing below sends one even though this is where the dry-run finishes.
 */
@Injectable()
export class ValidateImportService {
  private readonly logger = new Logger(ValidateImportService.name);

  constructor(
    @Inject(IMPORT_JOB_REPOSITORY) private readonly jobs: ImportJobRepositoryPort,
    @Inject(DOCUMENT_PORT) private readonly documents: DocumentPort,
    @Inject(WORKBOOK_READER) private readonly reader: WorkbookReaderPort,
    @Inject(WORKBOOK_WRITER) private readonly writer: WorkbookWriterPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly validation: RowValidationService,
  ) {}

  async validate(jobId: string): Promise<Result<ImportJobRow>> {
    const job = await this.jobs.findById(jobId);
    if (!job) return fail(sharedErrors.notFound());

    const definition = findImportDefinition(job.type);
    if (!definition) {
      // A definition that was registered when the job was created and is gone
      // now means a release removed it mid-flight. There is nothing to validate
      // against and nothing a row error could say about it.
      return this.markFailed(job.id, failureCodes.fileUnreadable);
    }

    await this.jobs.update(job.id, { status: 'validating' });

    const parsed = await this.parse(job.fileId, definition);
    if (!parsed.ok) return this.markFailed(job.id, parsed.error.code);

    const pass = await this.validation.run(definition, parsed.value.rows);
    const errorReportFileId = await this.writeErrorReport(
      job.id,
      definition,
      parsed.value,
      pass.report.verdicts,
    );

    const updated = await this.jobs.update(job.id, {
      status: 'awaiting_confirmation',
      templateVersion: parsed.value.templateVersion,
      totalRows: pass.report.totalRows,
      validRows: pass.report.validRows,
      errorRows: pass.report.errorRows,
      errorReportFileId,
      failureCode: null,
    });
    return updated ? ok(updated) : fail(sharedErrors.notFound());
  }

  /**
   * The three job-level failures, in UC-IMP-002's stated order: *"`_meta`
   * version check (→ `IMP_TEMPLATE_STALE`), structural readability (→
   * `IMP_FILE_UNREADABLE`), row cap (→ `IMP_ROW_CAP_EXCEEDED`) — job-level
   * failures short-circuit to `failed`."*
   *
   * Readability and the cap belong to the parser and are returned by it; the
   * marker is checked here, immediately after, which is what BR-IMP-006 buys —
   * *"one specific error instead of fifty mysterious row failures"*. Not one row
   * is coerced before the version is known.
   */
  private async parse(
    fileId: string,
    definition: ImportDefinition,
  ): Promise<Result<ParsedWorkbook>> {
    const content = await this.documents.openContent(fileId);
    if (!content) return fail(importExportErrors.fileUnreadable());

    const maxRows = await this.settings.resolve<number>(MAX_ROWS_KEY);
    const workbook = await this.reader.read(content, maxRows);
    if (!workbook.ok) return workbook;

    if (workbook.value.templateVersion !== definition.templateVersion) {
      return fail(
        importExportErrors.templateStale({
          expected: definition.templateVersion,
          found: workbook.value.templateVersion,
        }),
      );
    }
    return workbook;
  }

  /**
   * BR-IMP-009's workbook, stored through document-storage's worker path
   * (UC-DOC-004) under the same `import_file` category as the source and
   * parented to the job — so BR-IMP-010's read rule covers it without a second
   * one: *"import source files + error workbooks: any definition-permission
   * holder"*.
   *
   * A clean file gets **no** report. An empty workbook attached to a successful
   * dry-run is a download that tells the reader nothing and a link the wizard
   * would have to explain.
   */
  private async writeErrorReport(
    jobId: string,
    definition: ImportDefinition,
    workbook: ParsedWorkbook,
    verdicts: readonly RowVerdict[],
  ): Promise<string | null> {
    if (verdicts.length === 0) return null;

    const locale: Locale = DEFAULT_LOCALE;
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
            locale,
            headers: workbook.headers,
            rows: workbook.rows,
            verdicts,
          },
          sink,
        ),
    );
    return file.id;
  }

  private async markFailed(jobId: string, failureCode: string): Promise<Result<ImportJobRow>> {
    this.logger.warn(`import job ${jobId} failed validation: ${failureCode}`);
    const updated = await this.jobs.update(jobId, {
      status: 'failed',
      failureCode,
      completedAt: this.clock.now(),
    });
    // The job-level code is on the row rather than raised: this runs in a worker
    // with no caller to answer, and §7's polling contract is where the wizard
    // reads it (`failureCode`).
    return updated ? ok(updated) : fail(sharedErrors.notFound());
  }
}
