import { AppError } from '../../../shared/app-error';
import { sharedErrors } from '../../../shared/shared.errors';

import type { ImportJobStatus } from './import-export.types';

/**
 * §11's five codes, and §11's own sentence is the boundary: *"job-level only —
 * row-level errors use `VAL_*` + module codes inside workbooks (BR-IMP-009)"*.
 *
 * So a bad cell never raises one of these. A cell that fails coercion is a
 * `VAL_` entry in the error workbook, a row the `rowHandler` refuses carries
 * that module's own code, and neither reaches HTTP at all — §8 says row-level
 * rules are *"never HTTP errors"*. What is left here is the five ways a **job**
 * fails, which is what a caller can actually branch on.
 *
 * Two conditions deliberately take no code, both on §7's own instruction: an
 * unregistered `type` is `VAL_INVALID_ENUM`, and a `fileId` that is missing, of
 * the wrong category, or somebody else's is a 404 (existence hiding,
 * error-catalog §2).
 */
export const importExportErrors = {
  /** BR-IMP-006 — the `_meta` marker is absent or names another version. */
  templateStale: (params: { expected: number; found: number | null }) =>
    new AppError('IMP_TEMPLATE_STALE', params),

  /** UC-IMP-002 — a valid zip whose sheets are garbage, or a protected workbook. */
  fileUnreadable: () => new AppError('IMP_FILE_UNREADABLE'),

  /** BR-IMP-007 — rows beyond `import-export.max_rows`, counted at parse. */
  rowCapExceeded: (params: { maxRows: number }) => new AppError('IMP_ROW_CAP_EXCEEDED', params),

  /** BR-IMP-005 — one active import per tenant + type. */
  alreadyRunning: (params: { activeJobId: string }) => new AppError('IMP_ALREADY_RUNNING', params),

  /** UC-IMP-003/004 — confirm or cancel outside `awaiting_confirmation`. */
  invalidState: (params: { status: ImportJobStatus }) => new AppError('IMP_INVALID_STATE', params),
} as const;

/**
 * The same codes again, as `import_jobs.failure_code` / `export_jobs.failure_code`
 * store them — §4.1's *"job-level `IMP_` code when failed"*.
 *
 * They live here rather than as literals at the assignment because
 * coding-standards-nestjs §3 makes an error factory the only place a code is
 * spelled, and a column holding a code is the same contract as a response
 * carrying one: `SYS_INTERNAL` typed by hand in a service is the string that
 * survives a rename of everything around it.
 */
export const failureCodes = {
  fileUnreadable: importExportErrors.fileUnreadable().code,
  /** §9's *"row handler throws unexpectedly (bug, not validation)"* — a `SYS`-class failure. */
  internal: sharedErrors.internal().code,
} as const;

export const importExportErrorStatus = {
  IMP_TEMPLATE_STALE: 422,
  IMP_FILE_UNREADABLE: 422,
  IMP_ROW_CAP_EXCEEDED: 422,
  IMP_ALREADY_RUNNING: 409,
  IMP_INVALID_STATE: 409,
} as const;
