import { AppError } from './app-error';
import type { ErrorDetailEntry } from './envelope';
import { FIELD_ENTRIES } from './validation-details';

/**
 * The cross-module `VAL_` and `SYS_` codes (error-catalog §3, §4).
 *
 * Every other prefix belongs to a module and lives in that module's
 * `*.errors.ts`. These two have no owning module by design — they are the
 * catalog's own seed — so this file is their factory, and it exists for the same
 * reason the module ones do: a code spelled in more than one place is a code
 * that drifts from the catalog one grep at a time.
 */
export const sharedErrors = {
  internal: () => new AppError('SYS_INTERNAL'),
  routeNotFound: () => new AppError('SYS_ROUTE_NOT_FOUND'),
  notFound: () => new AppError('SYS_NOT_FOUND'),
  rateLimited: (params: { retryAfterSeconds: number }) => new AppError('SYS_RATE_LIMITED', params),
  invalidCursor: () => new AppError('VAL_INVALID_CURSOR'),
  validationFailed: (entries: ErrorDetailEntry[]) =>
    new AppError('VAL_VALIDATION_FAILED', { [FIELD_ENTRIES]: entries }),
} as const;

/** Field-level codes, referenced by the validation pipe's constraint map. */
export const fieldCodes = {
  required: 'VAL_REQUIRED',
  invalidFormat: 'VAL_INVALID_FORMAT',
  invalidEnum: 'VAL_INVALID_ENUM',
  tooShort: 'VAL_TOO_SHORT',
  tooLong: 'VAL_TOO_LONG',
  outOfRange: 'VAL_OUT_OF_RANGE',
  dateRangeInvalid: 'VAL_DATE_RANGE_INVALID',
} as const;

export const sharedErrorStatus = {
  SYS_INTERNAL: 500,
  SYS_ROUTE_NOT_FOUND: 404,
  SYS_NOT_FOUND: 404,
  SYS_RATE_LIMITED: 429,
  SYS_SERVICE_UNAVAILABLE: 503,
  VAL_VALIDATION_FAILED: 422,
  // 400, not 422: the cursor is opaque and client-supplied verbatim, so there is
  // no field for a `VAL_` entry array to point at (error-catalog §4, ADR-0007).
  VAL_INVALID_CURSOR: 400,
} as const;
