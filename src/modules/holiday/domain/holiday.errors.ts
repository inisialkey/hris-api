import { AppError } from '../../../shared/app-error';

/**
 * §11's two codes, and the only place either is spelled
 * (coding-standards-nestjs §3).
 */
export const holidayErrors = {
  /** BR-HOL-004 — `observed = false` with no broader row of the same `(date, kind)`. */
  nothingToOverride: (params: { date: string; kind: string }) =>
    new AppError('HOL_NOTHING_TO_OVERRIDE', params),
  /** BR-HOL-008 — the date is inside a locked attendance/payroll period. */
  periodLocked: (params: { date: string; periodId: string }) =>
    new AppError('HOL_PERIOD_LOCKED', params),
} as const;

export const holidayErrorStatus = {
  HOL_NOTHING_TO_OVERRIDE: 422,
  HOL_PERIOD_LOCKED: 409,
} as const;

/**
 * The same two codes as row verdicts. An import row cannot carry an `AppError`
 * into the error workbook — the framework wants a code and params — and a string
 * literal at the call site would be the second place a code is spelled.
 */
export const holidayRowCodes = {
  nothingToOverride: 'HOL_NOTHING_TO_OVERRIDE',
  periodLocked: 'HOL_PERIOD_LOCKED',
} as const;
