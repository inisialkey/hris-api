import type { importJobStatus, exportJobStatus } from '../../../database/schema';

export type ImportJobStatus = (typeof importJobStatus.enumValues)[number];
export type ExportJobStatus = (typeof exportJobStatus.enumValues)[number];

/** D12's two locales. Same shape notification uses, same reason (A-198). */
export type Locale = 'id' | 'en';

export interface LocalizedText {
  readonly id: string;
  readonly en: string;
}

/**
 * A cell after BR-IMP-008's coercion, and the four types are the whole set.
 *
 * A `decimal` column lands here as a **string**, never a number: money enters
 * and leaves the process as a decimal string (coding-standards-nestjs §5.1,
 * ADR-0007), and a float that has already lost a rupiah cannot be rescued by the
 * repository that stores it. `date` lands as `YYYY-MM-DD` for the same class of
 * reason — a midnight timestamp manufactures off-by-one-day bugs across the
 * three Indonesian timezones (coding-standards-nestjs §6).
 */
export type CellValue = string | number | boolean | null;

/** One row of the uploaded workbook, keyed by column and numbered as it sits. */
export interface ParsedRow {
  /**
   * The worksheet row number, 1-based, exactly as Excel shows it — BR-IMP-009's
   * *"original row numbers"*. Not the index into a filtered array: an error
   * report a user cannot line up against their own file is not a report.
   */
  readonly rowNumber: number;
  readonly values: Readonly<Record<string, CellValue>>;
}

/**
 * One reason one row was refused.
 *
 * BR-IMP-009: row-level codes are field-level `VAL_*` plus the owning module's
 * business codes, supplied by the definition's validators — `IMP_` codes describe
 * job-level failures only. `column` is `null` for a whole-row verdict (a
 * cross-row duplicate, a rowHandler refusal that names no field).
 */
export interface RowError {
  readonly column: string | null;
  readonly code: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface RowVerdict {
  readonly rowNumber: number;
  readonly errors: readonly RowError[];
}

/** What one pass over a workbook produced — UC-IMP-002's whole result. */
export interface ValidationReport {
  readonly totalRows: number;
  readonly validRows: number;
  readonly errorRows: number;
  readonly verdicts: readonly RowVerdict[];
}

export interface ImportJobRow {
  readonly id: string;
  readonly type: string;
  readonly status: ImportJobStatus;
  readonly fileId: string;
  readonly errorReportFileId: string | null;
  readonly templateVersion: number | null;
  readonly totalRows: number | null;
  readonly validRows: number | null;
  readonly errorRows: number | null;
  readonly appliedRows: number | null;
  readonly lastCommittedBatch: number | null;
  readonly failureCode: string | null;
  readonly requestedBy: string | null;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface ExportJobRow {
  readonly id: string;
  readonly type: string;
  readonly status: ExportJobStatus;
  readonly params: ExportJobParams;
  readonly fileId: string | null;
  readonly rowCount: number | null;
  readonly failureCode: string | null;
  readonly requestedBy: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/** The caller's validated filter values — one definition's `ParamSpec` set, applied. */
export type ExportParams = Readonly<Record<string, string | number | boolean>>;

/**
 * What `export_jobs.params` actually holds: the caller's filters, plus the
 * column entitlement UC-IMP-006 freezes at enqueue.
 *
 * *"permission-gated column sets resolved from the requester's effective
 * permissions at enqueue, **frozen into params**"* — so the frozen set is stored
 * where the rule says, under a reserved key rather than in a column of its own.
 * §9's revoked-permission case is the whole point: the file matches what the
 * requester was entitled to **when they asked**, and re-resolving at generation
 * time would silently produce a narrower file than the job promised.
 */
export interface ExportJobParams extends Readonly<Record<string, unknown>> {
  readonly _columns: readonly string[];
  /** Whether any frozen column came from a gated set — BR-IMP-010's audit hook. */
  readonly _gated: boolean;
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export interface Paged<T> {
  readonly rows: T[];
  readonly total: number;
}
