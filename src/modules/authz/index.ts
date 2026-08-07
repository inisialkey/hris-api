// The authz facade — the only import path other modules may use (ADR-0001 §1).

export { AuthzModule } from './authz.module';
// approval-engine's `role_holders` resolver and BR-APRV-006's fallback rung.
// Additive to authorization-rbac.md §4 (A-196, hris-handbook PR #30).
export { ROLE_HOLDER_PORT, type RoleHolderPort } from './domain/role-holder.port';
export { PermissionResolverService } from './application/permission-resolver.service';
// A module refusing an action on a permission key it resolved itself raises the
// same code the guard does — one condition, one code (error-catalog §1).
export { authzErrors } from './domain/authz.errors';
export { PermissionGuard } from './presentation/permission.guard';
export {
  AuthenticatedOnly,
  IS_AUTHENTICATED_ONLY,
  IS_PUBLIC,
  PERMISSION_KEYS,
  Public,
  RequirePermission,
} from './presentation/authz.decorators';
