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
} as const;

export const authErrorStatus = {
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_ACCOUNT_LOCKED: 403,
  AUTH_TOKEN_INVALID: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_SESSION_REVOKED: 401,
  AUTH_TENANT_SUSPENDED: 403,
} as const;
