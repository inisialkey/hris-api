// The authz facade — the only import path other modules may use (ADR-0001 §1).

export { AuthzModule } from './authz.module';
export { PermissionResolverService } from './application/permission-resolver.service';
export { PermissionGuard } from './presentation/permission.guard';
export {
  AuthenticatedOnly,
  IS_AUTHENTICATED_ONLY,
  IS_PUBLIC,
  PERMISSION_KEYS,
  Public,
  RequirePermission,
} from './presentation/authz.decorators';
