import { AppError } from '../../../shared/app-error';

/** §11's four codes, and the only place any of them is spelled (coding-standards §3). */
export const shiftErrors = {
  /** BR-SHF-006 — the write would leave two punch windows overlapping for one employee. */
  windowOverlap: (params: Record<string, unknown>) =>
    new AppError('SHF_SHIFT_WINDOW_OVERLAP', params),
  /** BR-SHF-007 — a range collides with existing history, or a second default is live. */
  assignmentOverlap: (params: Record<string, unknown>) =>
    new AppError('SHF_ASSIGNMENT_OVERLAP', params),
  /** BR-SHF-011 — archive blocked by live dependents. */
  inUse: (params: { blockers: { type: string; count: number }[] }) =>
    new AppError('SHF_IN_USE', params),
  /** BR-SHF-009 — the write touches a date inside a locked period. */
  periodLocked: (params: { date: string; periodId: string }) =>
    new AppError('SHF_PERIOD_LOCKED', params),
} as const;

export const shiftErrorStatus = {
  SHF_SHIFT_WINDOW_OVERLAP: 409,
  SHF_ASSIGNMENT_OVERLAP: 409,
  SHF_IN_USE: 409,
  SHF_PERIOD_LOCKED: 409,
} as const;

/**
 * The same codes as import row verdicts. A row error carries a code and params
 * rather than an `AppError`, and a literal at the call site would be the second
 * place a code is spelled.
 */
export const shiftRowCodes = {
  windowOverlap: 'SHF_SHIFT_WINDOW_OVERLAP',
  periodLocked: 'SHF_PERIOD_LOCKED',
} as const;
