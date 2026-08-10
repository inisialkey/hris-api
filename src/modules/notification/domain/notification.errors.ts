import { AppError } from '../../../shared/app-error';

/**
 * §11's one `NTF_` code, and one is the whole surface this module can refuse
 * with. Everything else it answers is a read of the caller's own rows: another
 * user's notification is `SYS_NOT_FOUND` (existence hiding, error-catalog §2)
 * rather than a code of its own, and an unknown template key or channel is
 * `VAL_INVALID_ENUM` from §8's validation layer, not a business failure.
 */
export const notificationErrors = {
  /**
   * BR-NTF-005 — a preference toggle on a preference-immune template. Security
   * notices, approval actionables and statutory documents are not opinions.
   */
  templateMandatory: (params: { templateKey: string }) =>
    new AppError('NTF_TEMPLATE_MANDATORY', params),
} as const;

export const notificationErrorStatus = {
  NTF_TEMPLATE_MANDATORY: 422,
} as const;
