import { authzErrors } from '../modules/authz/domain/authz.errors';
import { requireRequestContext } from './context';
import { type Result, fail, ok } from './result';
import { sharedErrors } from './shared.errors';

/**
 * ADR-0005's second axis — *"modules resolve row visibility … through **shared
 * ownership helpers**"* — which is this file, and which is why it sits in
 * `shared/` rather than being copied into every module that needs it.
 *
 * ADR-0001 rule 4's whitelist is amended in place to name it (A-195, the
 * rate-limit-guard precedent of 2026-08-05: an addition to the list, not a
 * change to what the list is for). It qualifies on the same two grounds the
 * guard did — no business logic, no schema, and an owner nobody can honestly
 * claim: organization, employee, and every module after them resolve the same
 * company scope from the same assignment set, and the module that happens to
 * be built first does not own the rule for the rest.
 *
 * Guards never do data scoping (ADR-0005 §Enforcement); use cases and
 * repositories do, and these are the helpers they call.
 */

/**
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
 * An out-of-scope company is **404, not 403** — telling a company-scoped admin
 * that a company they may not see exists is the disclosure the scope was drawn
 * to prevent (api-standards §11, existence hiding).
 */
export async function requireCompanyInScope(companyId: string): Promise<Result<void>> {
  const scope = await companyScope();
  if (scope === null || scope.includes(companyId)) return ok(undefined);
  return fail(sharedErrors.notFound());
}

/**
 * Tenant-wide objects — companies themselves, job levels — need a tenant-wide
 * assignment. A company-scoped admin holding the permission key still cannot
 * create one, because the object belongs to no company they were given.
 *
 * This raises the guard's own code rather than a module one: the condition is
 * "your assignment does not reach this", which is what `AUTHZ_PERMISSION_DENIED`
 * already means to a client (error-catalog §1).
 */
export async function requireTenantWide(permission: string): Promise<Result<void>> {
  const scope = await companyScope();
  return scope === null ? ok(undefined) : fail(authzErrors.permissionDenied({ permission }));
}
