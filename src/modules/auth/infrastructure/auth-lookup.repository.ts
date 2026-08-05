import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { tenants, users } from '../../../database/schema';
import { UnitOfWork } from '../../../database/unit-of-work';
import type { AuthLookupRepositoryPort, CandidateUser, TenantSummary } from '../domain/auth.ports';

/**
 * The pre-tenant lookup path (authentication.md §4, multi-tenancy §4).
 *
 * Login happens before a tenant context exists — the whole point of the email
 * scan is to find out which tenants there are — so under plain `hris_app` with
 * FORCE RLS these SELECTs would return zero rows and login would be structurally
 * impossible. This is the single sanctioned answer: a `NOLOGIN` role with
 * SELECT-only, column-narrow grants on four tables, assumed with `SET LOCAL ROLE`
 * so it is transaction-scoped and therefore pooling-safe, and reverted at commit.
 *
 * It is not a general RLS bypass, and the difference is enumerable: `hris_auth`
 * can write nothing and can read nothing else (leak test L7).
 *
 * Every write that follows a successful lookup — the session insert, the
 * `last_login_at` stamp — runs under the resolved tenant's normal `set_config`
 * context, not here.
 */
@Injectable()
export class AuthLookupRepository implements AuthLookupRepositoryPort {
  constructor(
    private readonly connection: ConnectionProvider,
    private readonly uow: UnitOfWork,
  ) {}

  /** Every live user carrying this email, across all tenants. */
  async findCandidatesByEmail(email: string): Promise<CandidateUser[]> {
    return this.uow.runWithoutTenant(async () => {
      const db = this.connection.handle();
      await db.execute(sql`SET LOCAL ROLE hris_auth`);

      const rows = await db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
          passwordHash: users.passwordHash,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deletedAt)));

      return rows;
    });
  }

  /**
   * Tenant names and statuses for the candidates.
   *
   * Deliberately **not** under `hris_auth`: `tenants` is a platform table with no
   * RLS and no grant to that role, and widening the role to reach it would widen
   * the one credential whose narrowness is the security property. `hris_app`
   * reads platform tables with no tenant variable set, which is exactly what a
   * platform table means.
   */
  async findTenants(ids: readonly string[]): Promise<TenantSummary[]> {
    if (ids.length === 0) return [];
    return this.uow.runWithoutTenant(async () => {
      const db = this.connection.handle();
      const rows = await db
        .select({ id: tenants.id, name: tenants.name, status: tenants.status })
        .from(tenants)
        .where(and(isNull(tenants.deletedAt), inArray(tenants.id, [...ids])));
      return rows;
    });
  }
}
