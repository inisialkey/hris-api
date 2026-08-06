import { AppError } from '../../../shared/app-error';

/**
 * The only place `AUTH_` codes are spelled (backend-nestjs §7.3).
 *
 * `invalidCredentials` takes no parameters and never will. Unknown email, wrong
 * password, and an `inactive` user are one code with one response time
 * (BR-AUTH-002) — a parameter distinguishing them would be an enumeration oracle
 * with a nice name.
 */
export const authErrors = {
  invalidCredentials: () => new AppError('AUTH_INVALID_CREDENTIALS'),
  accountLocked: (params?: { retryAfterSeconds: number }) =>
    new AppError('AUTH_ACCOUNT_LOCKED', params),
  tokenInvalid: () => new AppError('AUTH_TOKEN_INVALID'),
  tokenExpired: () => new AppError('AUTH_TOKEN_EXPIRED'),
  sessionRevoked: (params: { reason: string }) => new AppError('AUTH_SESSION_REVOKED', params),
  tenantSuspended: () => new AppError('AUTH_TENANT_SUSPENDED'),
  // Unknown, expired, revoked and not-a-session are one code (BR-AUTH-006):
  // telling a caller *why* a refresh token is dead tells an attacker which
  // guesses were close.
  refreshInvalid: () => new AppError('AUTH_REFRESH_INVALID'),
  refreshReused: () => new AppError('AUTH_REFRESH_REUSED'),
  deviceRevoked: () => new AppError('AUTH_DEVICE_REVOKED'),
  deviceLimitReached: (params: { maxDevices: number; policy: string }) =>
    new AppError('AUTH_DEVICE_LIMIT_REACHED', params),
  resetTokenInvalid: () => new AppError('AUTH_RESET_TOKEN_INVALID'),
  inviteTokenInvalid: () => new AppError('AUTH_INVITE_TOKEN_INVALID'),
  /** `entries` ride the FIELD_ENTRIES carrier — the wire shape is field-level (§8). */
  passwordPolicyViolation: (details: Record<string, unknown>) =>
    new AppError('AUTH_PASSWORD_POLICY_VIOLATION', details),
} as const;

/**
 * Field-level codes for the password policy's entries (§8: "policy rules as
 * field-level codes"). The two `VAL_` names are the shared transport pair;
 * the two `AUTH_` names are this module's policy rules.
 */
export const authFieldCodes = {
  tooShort: 'VAL_TOO_SHORT',
  tooLong: 'VAL_TOO_LONG',
  breached: 'AUTH_PASSWORD_BREACHED',
  derived: 'AUTH_PASSWORD_DERIVED',
} as const;

export const authErrorStatus = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_ACCOUNT_LOCKED: 403,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_SESSION_REVOKED: 401,
  AUTH_TENANT_SUSPENDED: 403,
  AUTH_REFRESH_INVALID: 401,
  AUTH_REFRESH_REUSED: 401,
  AUTH_DEVICE_REVOKED: 401,
  AUTH_DEVICE_LIMIT_REACHED: 409,
  AUTH_RESET_TOKEN_INVALID: 401,
  AUTH_INVITE_TOKEN_INVALID: 401,
  AUTH_PASSWORD_POLICY_VIOLATION: 422,
} as const;
