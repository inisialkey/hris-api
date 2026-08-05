import { AppError } from '../../../shared/app-error';

/**
 * The only place `AUTHZ_` codes are spelled (backend-nestjs §7.3). A code string
 * literal anywhere else is a lint error, which is what keeps the catalog and the
 * code from drifting apart one grep at a time.
 */
export const authzErrors = {
  permissionDenied: (params: { permission: string }) =>
    new AppError('AUTHZ_PERMISSION_DENIED', params),
} as const;

/** Registered into the filter's map at module init. */
export const authzErrorStatus = {
  AUTHZ_PERMISSION_DENIED: 403,
} as const;
