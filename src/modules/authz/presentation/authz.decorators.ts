import { SetMetadata } from '@nestjs/common';

/**
 * The three route markers of ADR-0005. Every route carries exactly one of them;
 * a route with none is a **CI failure**, not a silent pass — deny by default,
 * structurally (`scripts/route-lint.ts`, backend-nestjs §12).
 *
 * `@RequirePermission` is one decorator doing three jobs deliberately: it feeds
 * `PermissionGuard`, it emits the key into the Swagger operation description, and
 * it is what the route lint scans. One source of truth for enforcement, docs,
 * and CI (backend-nestjs §5).
 */

export const PERMISSION_KEYS = 'hris:permission-keys';
export const IS_PUBLIC = 'hris:public';
export const IS_AUTHENTICATED_ONLY = 'hris:authenticated-only';

/** Multiple keys are AND unless the module doc documents otherwise (ADR-0005). */
export const RequirePermission = (...keys: [string, ...string[]]) =>
  SetMetadata(PERMISSION_KEYS, keys);

/** Skips guards 3–5 (backend-nestjs §5). Login, refresh, reset, health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Authenticated, no permission key. Own-scope surfaces: `/auth/me`, self-service
 * sessions and devices, employee self-service. Data scope is resolved in
 * repositories (BR-AUTHZ-009), never here — guards never do data scoping.
 */
export const AuthenticatedOnly = () => SetMetadata(IS_AUTHENTICATED_ONLY, true);
