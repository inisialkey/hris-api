import { AppError } from '../../../shared/app-error';

/**
 * §11's five `DOC_` codes, and all five are reachable from this module.
 *
 * The gate failures are not here on purpose. §2 delegates file authorization to
 * the owning category and hides a scope miss behind 404, so a caller who may not
 * attach to an entity gets `SYS_NOT_FOUND` — the same answer as an entity that
 * does not exist, which is the point.
 */
export const documentErrors = {
  /** UC-DOC-001 — declared mime outside the category whitelist. */
  typeNotAllowed: (params: { allowed: readonly string[] }) =>
    new AppError('DOC_TYPE_NOT_ALLOWED', { ...params }),
  /** UC-DOC-001/002 — declared or verified size over the effective cap. */
  sizeExceeded: (params: { maxBytes: number }) => new AppError('DOC_SIZE_EXCEEDED', params),
  /** BR-DOC-004 — confirm found no object, or an empty one. */
  uploadIncomplete: () => new AppError('DOC_UPLOAD_INCOMPLETE'),
  /**
   * BR-DOC-005 — and it fires *"even when the actual type would itself be
   * allowed"*, because a client that mislabels its bytes is a client whose
   * declaration the signed PUT was constrained on.
   */
  mimeMismatch: (params: { declared: string; sniffed: string }) =>
    new AppError('DOC_MIME_MISMATCH', params),
  /** BR-DOC-009 — statutory retention, or a system artifact nobody may remove. */
  deleteForbidden: (params: { category: string }) => new AppError('DOC_DELETE_FORBIDDEN', params),
} as const;

export const documentErrorStatus = {
  DOC_TYPE_NOT_ALLOWED: 422,
  DOC_SIZE_EXCEEDED: 422,
  DOC_UPLOAD_INCOMPLETE: 422,
  DOC_MIME_MISMATCH: 422,
  DOC_DELETE_FORBIDDEN: 409,
} as const;
