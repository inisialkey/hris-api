/**
 * Out-ports for permission resolution.
 *
 * The resolver is application-layer logic — additive union, tenant-wide widening
 * — over two things it must not own: a database read and a cache. Both are
 * behind tokens so `application/` never imports `src/database` or ioredis, which
 * is also what makes the resolver testable without either.
 */

export interface RoleAssignment {
  roleId: string;
  companyId: string | null;
}

export const ASSIGNMENT_QUERY = Symbol('ASSIGNMENT_QUERY');

export interface AssignmentQueryPort {
  findAssignments(userId: string): Promise<RoleAssignment[]>;
  findPermissionKeys(roleIds: readonly string[]): Promise<string[]>;
}

export const PERMISSION_CACHE = Symbol('PERMISSION_CACHE');

export interface CachedAuthorization {
  permissions: string[];
  companyScope: 'all' | string[];
}

export interface PermissionCachePort {
  get(tenantId: string, userId: string): Promise<CachedAuthorization | null>;
  set(tenantId: string, userId: string, value: CachedAuthorization): Promise<void>;
  /** The explicit bust half of ADR-0005's bounded-staleness promise. */
  invalidate(tenantId: string, userId: string): Promise<void>;
}

export const TENANT_TRANSACTION_AUTHZ = Symbol('TENANT_TRANSACTION_AUTHZ');

export interface AuthzTransactionPort {
  runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}
