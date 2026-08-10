import type { Readable, Writable } from 'node:stream';

import type { Result } from '../../../shared/result';
import type { ExportColumn, ExportDefinition, ImportDefinition } from './definitions';
import type {
  ExportJobParams,
  ExportJobRow,
  ExportJobStatus,
  ExportParams,
  ImportJobRow,
  ImportJobStatus,
  Locale,
  Page,
  Paged,
  RowVerdict,
} from './import-export.types';

export const IMPORT_JOB_REPOSITORY = Symbol('IMPORT_JOB_REPOSITORY');

export interface ImportJobFilter {
  readonly type?: string;
  readonly status?: ImportJobStatus;
}

/** Everything a state transition writes, in one patch — §4.1's columns. */
export interface ImportJobPatch {
  readonly status?: ImportJobStatus;
  readonly templateVersion?: number | null;
  readonly totalRows?: number | null;
  readonly validRows?: number | null;
  readonly errorRows?: number | null;
  readonly appliedRows?: number | null;
  readonly lastCommittedBatch?: number | null;
  readonly errorReportFileId?: string | null;
  readonly failureCode?: string | null;
  readonly confirmedBy?: string | null;
  readonly confirmedAt?: Date | null;
  readonly completedAt?: Date | null;
}

export interface ImportJobRepositoryPort {
  /**
   * BR-IMP-005's guard is the **partial unique index**, so this is an insert that
   * may collide rather than a read-then-write. `null` means the index refused it
   * and the caller looks up the winner — §9's *"partial unique index decides at
   * insert"*, which is the only version of that check without a race between the
   * check and the insert.
   */
  insertIfNoneActive(type: string, fileId: string): Promise<ImportJobRow | null>;
  findActive(type: string): Promise<ImportJobRow | null>;
  findById(id: string): Promise<ImportJobRow | null>;
  list(filter: ImportJobFilter, page: Page): Promise<Paged<ImportJobRow>>;
  update(id: string, patch: ImportJobPatch): Promise<ImportJobRow | null>;
  /**
   * BR-IMP-011's sweep: `awaiting_confirmation` older than the window. Returns
   * the rows rather than updating them, because the caller also notifies.
   */
  staleAwaitingConfirmation(confirmedBefore: Date, limit: number): Promise<ImportJobRow[]>;
  /** BR-IMP-011's transition, guarded so a confirm landing first wins. */
  cancelIfAwaiting(id: string, at: Date): Promise<boolean>;
  /**
   * §9's *"two admins confirm simultaneously: status guard + optimistic update —
   * one wins, the other gets `IMP_INVALID_STATE { status: 'committing' }`"*. The
   * predicate is the whole race; a read-then-write would let both through.
   */
  confirmIfAwaiting(id: string, by: string | undefined, at: Date): Promise<ImportJobRow | null>;
  /** §12's purge — terminal rows older than the retention window. */
  terminalCreatedBefore(cutoff: Date, limit: number): Promise<ImportJobRow[]>;
  deleteById(id: string): Promise<void>;
}

export const EXPORT_JOB_REPOSITORY = Symbol('EXPORT_JOB_REPOSITORY');

export interface ExportJobPatch {
  readonly status?: ExportJobStatus;
  readonly fileId?: string | null;
  readonly rowCount?: number | null;
  readonly failureCode?: string | null;
  readonly completedAt?: Date | null;
}

export interface ExportJobRepositoryPort {
  insert(type: string, params: ExportJobParams): Promise<ExportJobRow>;
  findById(id: string): Promise<ExportJobRow | null>;
  /** BR-IMP-010's resolver read: which export job produced this output file. */
  findByFileId(fileId: string): Promise<ExportJobRow | null>;
  list(
    filter: { type?: string; status?: ExportJobStatus },
    page: Page,
  ): Promise<Paged<ExportJobRow>>;
  update(id: string, patch: ExportJobPatch): Promise<ExportJobRow | null>;
  terminalCreatedBefore(cutoff: Date, limit: number): Promise<ExportJobRow[]>;
  deleteById(id: string): Promise<void>;
}

export const WORKBOOK_READER = Symbol('WORKBOOK_READER');

/** One row exactly as it sits in the sheet, before any column is named. */
export interface SheetRow {
  readonly rowNumber: number;
  readonly cells: readonly unknown[];
}

export interface ParsedWorkbook {
  /** `null` when the `_meta` sheet is absent — BR-IMP-006's stale case. */
  readonly templateVersion: number | null;
  readonly headers: readonly string[];
  readonly rows: readonly SheetRow[];
}

export interface WorkbookReaderPort {
  /**
   * ADR-0015's streaming read. Two job-level failures live here rather than in
   * the service because only the parser can see them: a workbook that will not
   * open (`IMP_FILE_UNREADABLE`) and one whose row count passes the cap
   * (`IMP_ROW_CAP_EXCEEDED`) — the second aborts mid-stream, which is the point
   * of the bound.
   */
  read(source: Readable, maxRows: number): Promise<Result<ParsedWorkbook>>;
}

export const WORKBOOK_WRITER = Symbol('WORKBOOK_WRITER');

export interface ErrorReportInput {
  readonly definition: ImportDefinition;
  readonly locale: Locale;
  readonly headers: readonly string[];
  readonly rows: readonly SheetRow[];
  readonly verdicts: readonly RowVerdict[];
}

export interface ExportWriteInput {
  readonly definition: ExportDefinition;
  readonly locale: Locale;
  readonly columns: readonly ExportColumn[];
  readonly params: ExportParams;
  readonly stream: AsyncIterable<Readonly<Record<string, string | number | boolean | null>>>;
}

export interface WorkbookWriterPort {
  /** UC-IMP-005 — headers, one example row, the enum sheet and the `_meta` marker. */
  template(definition: ImportDefinition, locale: Locale, sink: Writable): Promise<void>;
  /** BR-IMP-009 — the input mirrored, with original row numbers and per-row codes. */
  errorReport(input: ErrorReportInput, sink: Writable): Promise<void>;
  /** UC-IMP-006 — streamed rows, injection-guarded per cell. Returns the row count. */
  exportRows(input: ExportWriteInput, sink: Writable): Promise<number>;
}

export const IMPORT_EXPORT_OUTBOX = Symbol('IMPORT_EXPORT_OUTBOX');

/** §12's two events. Pointers only (coding-standards-nestjs §7). */
export interface ImportExportOutboxPort {
  emit(event: {
    name: 'import-export.import.committed' | 'import-export.export.completed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
