import { requireRequestContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { authzErrors } from '../../authz';

/**
 * §2's data scope, resolved once per call and handed to the repository — which
 * is where BR-AUTHZ-009 puts it, and never in a guard.
 *
 * `null` means tenant-wide: no company predicate at all, not "an empty list".
 * The distinction is the whole rule, because an empty list read as tenant-wide
 * would hand a user with no assignments the entire tenant.
 */
export async function companyScope(): Promise<string[] | null> {
  const authorization = await requireRequestContext().authorization?.resolve();
  if (!authorization) return [];
  return authorization.companyScope === 'all' ? null : [...authorization.companyScope];
}

/**
 * §2's out-of-scope answer is **404, not 403** — telling a company-scoped admin
 * that a company they may not see exists is the disclosure the scope was drawn
 * to prevent (api-standards §4, existence hiding).
 */
export async function requireCompanyInScope(companyId: string): Promise<Result<void>> {
  const scope = await companyScope();
  if (scope === null || scope.includes(companyId)) return ok(undefined);
  return fail(sharedErrors.notFound());
}

/**
 * Tenant-wide objects — companies themselves, job levels — need a tenant-wide
 * assignment (§2, the BR-AUTHZ-007 mirror). A company-scoped admin holding the
 * permission key still cannot create one, because the object belongs to no
 * company they were given.
 *
 * This raises the guard's own code rather than a module one: the condition is
 * "your assignment does not reach this", which is what `AUTHZ_PERMISSION_DENIED`
 * already means to a client (error-catalog §1).
 */
export async function requireTenantWide(permission: string): Promise<Result<void>> {
  const scope = await companyScope();
  return scope === null ? ok(undefined) : fail(authzErrors.permissionDenied({ permission }));
}
