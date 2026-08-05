import { Inject, Injectable } from '@nestjs/common';

import type { CompanyScope, ResolvedAuthorization, TenantContext } from '../../../shared/context';
import {
  ASSIGNMENT_QUERY,
  PERMISSION_CACHE,
  TENANT_TRANSACTION_AUTHZ,
  type AssignmentQueryPort,
  type AuthzTransactionPort,
  type CachedAuthorization,
  type PermissionCachePort,
} from './ports/authz.ports';

/**
 * Resolves one user's effective permission set and company scope.
 *
 * Both come from the same read — `user_roles` joined to `role_permissions` — so
 * they are cached together under one key. ADR-0005's lazy note is about *when*
 * the read happens, not how many reads it is, and splitting them would double
 * the miss cost of the surface the amendment was written to protect.
 *
 * Composition is additive-only: the effective set is the union of assignments.
 * No hierarchy, no inheritance, no deny rules — absence is denial, and "why does
 * this user see this?" is answerable by listing assignments rather than walking
 * a tree.
 */
@Injectable()
export class PermissionResolverService {
  constructor(
    @Inject(ASSIGNMENT_QUERY) private readonly assignments: AssignmentQueryPort,
    @Inject(PERMISSION_CACHE) private readonly cache: PermissionCachePort,
    @Inject(TENANT_TRANSACTION_AUTHZ) private readonly tx: AuthzTransactionPort,
  ) {}

  async resolve(tenant: TenantContext, userId: string): Promise<ResolvedAuthorization> {
    const cached = await this.cache.get(tenant.tenantId, userId);
    if (cached) return hydrate(cached);

    const fresh = await this.load(tenant, userId);
    await this.cache.set(tenant.tenantId, userId, dehydrate(fresh));
    return fresh;
  }

  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.cache.invalidate(tenantId, userId);
  }

  private async load(tenant: TenantContext, userId: string): Promise<ResolvedAuthorization> {
    // This runs at guard position 5, two positions before `TransactionInterceptor`
    // opens the request's transaction — so there is no `app.tenant_id` set yet and
    // a plain read would return zero rows under FORCE RLS. The lookup therefore
    // opens its own short tenant-scoped unit-of-work. It is a cache-miss path, and
    // the alternative would be moving the transaction ahead of authentication.
    return this.tx.runInTenant(tenant.tenantId, async () => {
      const assignments = await this.assignments.findAssignments(userId);
      if (assignments.length === 0) {
        return { permissions: new Set<string>(), companyScope: [] as readonly string[] };
      }

      const keys = await this.assignments.findPermissionKeys(assignments.map((a) => a.roleId));

      // Any tenant-wide assignment (`company_id IS NULL`) widens the whole scope
      // to `all`; otherwise it is the explicit list (multi-tenancy §3.1).
      const tenantWide = assignments.some((a) => a.companyId === null);
      const companyScope: CompanyScope = tenantWide
        ? 'all'
        : [...new Set(assignments.map((a) => a.companyId).filter((c): c is string => c !== null))];

      return { permissions: new Set(keys), companyScope };
    });
  }
}

function dehydrate(value: ResolvedAuthorization): CachedAuthorization {
  return {
    permissions: [...value.permissions],
    companyScope: value.companyScope === 'all' ? 'all' : [...value.companyScope],
  };
}

function hydrate(value: CachedAuthorization): ResolvedAuthorization {
  return {
    permissions: new Set(value.permissions),
    companyScope: value.companyScope === 'all' ? 'all' : value.companyScope,
  };
}
