import { AppError } from '../../../shared/app-error';

/** The `ORG_` block of error-catalog §15 — the module's five codes, spelled once. */
export const organizationErrors = {
  /** BR-ORG-006. The counts are the point: a confirm dialog lists blockers, never a bare toast. */
  inUse: (params: { blockers: { type: string; count: number }[] }) =>
    new AppError('ORG_IN_USE', params),
  cycleDetected: () => new AppError('ORG_CYCLE_DETECTED'),
  crossCompany: () => new AppError('ORG_CROSS_COMPANY'),
  assignmentOverlap: (params: { conflictingAssignmentId: string | null }) =>
    new AppError('ORG_ASSIGNMENT_OVERLAP', params),
  periodLocked: (params: { periodId: string | null }) => new AppError('ORG_PERIOD_LOCKED', params),
} as const;

export const organizationErrorStatus = {
  ORG_IN_USE: 409,
  ORG_CYCLE_DETECTED: 422,
  ORG_CROSS_COMPANY: 422,
  ORG_ASSIGNMENT_OVERLAP: 409,
  ORG_PERIOD_LOCKED: 409,
} as const;
