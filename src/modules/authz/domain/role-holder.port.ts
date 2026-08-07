export const ROLE_HOLDER_PORT = Symbol('ROLE_HOLDER_PORT');

/**
 * Who holds a role — the read the approval engine's `role_holders` resolver and
 * BR-APRV-006's fallback rung both need, and the one thing about `user_roles` no
 * other module can answer for itself (ADR-0001 rule 2).
 *
 * **Declared here rather than in the engine**, because a port belongs to the
 * module that owns the data. authorization-rbac.md declares no ports at all
 * today — it is consumed through the guard and `PermissionResolverService` —
 * which is why this is an additive handbook change rather than an
 * implementation of one (A-196, hris-handbook PR #30).
 *
 * `approval.fallback_role` names a role by **key** (`hr_admin`), so both lookups
 * are here: by id for a chain the admin configured, by key for the platform
 * default the tenant never touched.
 */
export interface RoleHolderPort {
  /**
   * Users holding the role in the company, **plus everyone holding it
   * tenant-wide**. A tenant-scoped grant reaches every company under ADR-0005,
   * so excluding those holders would make the tenant-wide HR Admin the fallback
   * names invisible to the fallback.
   */
  holderUserIds(roleId: string, companyId: string): Promise<string[]>;
  /** `null` when the tenant has no live role with that key. */
  findIdByKey(key: string): Promise<string | null>;
  /** §8's resolver-ref check — live role, this tenant (RLS supplies the tenant). */
  exists(roleId: string): Promise<boolean>;
}
