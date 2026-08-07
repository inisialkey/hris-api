import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalDelegations } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { requireTenantContext } from '../../../shared/context';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { DelegationRepositoryPort, Page, Paged } from '../domain/approval.ports';
import type { DelegationRow } from '../domain/approval.types';

/**
 * **Audited (channel 1)**, on `ChainRepository`'s reasoning: a delegation is a
 * grant of authority to act in someone else's name, which is `user_roles` shaped
 * rather than trail shaped. Revocation is an `UPDATE` of `revoked_at` rather
 * than a delete, so the diff records who ended it and when (A-196).
 *
 * §4 gives this table no `deleted_at` — a delegation ends through `revoked_at`,
 * which is an update — so the base's `live` predicate degrades to `true` here
 * rather than a column being invented to satisfy it.
 */
@Injectable()
export class DelegationRepository
  extends TenantScopedRepository
  implements DelegationRepositoryPort
{
  constructor(connection: ConnectionProvider, @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort) {
    super(connection, approvalDelegations, audit);
  }

  /**
   * Activation's one delegation read: every live delegation of every approver
   * the step resolved to, in one statement. A per-approver lookup inside the
   * resolution loop would be an N+1 on the hottest path in the engine
   * (coding-standards-nestjs §5).
   */
  async liveFor(delegatorUserIds: readonly string[], onDate: string): Promise<DelegationRow[]> {
    if (delegatorUserIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(
        and(
          inArray(approvalDelegations.delegatorUserId, [...delegatorUserIds]),
          isNull(approvalDelegations.revokedAt),
          lte(approvalDelegations.startDate, onDate),
          gte(approvalDelegations.endDate, onDate),
        ),
      );
    return rows.map(toDelegation);
  }

  /** The overlap pre-check's input — every row of the delegator, revoked included. */
  async listForDelegator(delegatorUserId: string): Promise<DelegationRow[]> {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(eq(approvalDelegations.delegatorUserId, delegatorUserId));
    return rows.map(toDelegation);
  }

  async list(filter: { delegatorUserId?: string }, page: Page): Promise<Paged<DelegationRow>> {
    const predicates: SQL[] = [];
    if (filter.delegatorUserId) {
      predicates.push(eq(approvalDelegations.delegatorUserId, filter.delegatorUserId));
    }
    const where = predicates.length > 0 ? and(...predicates) : undefined;

    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(where)
      .orderBy(desc(approvalDelegations.id))
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ value: count() }).from(approvalDelegations).where(where);

    return { rows: rows.map(toDelegation), total: totals[0]?.value ?? 0 };
  }

  async findById(id: string): Promise<DelegationRow | null> {
    const rows = await this.db
      .select()
      .from(approvalDelegations)
      .where(eq(approvalDelegations.id, id));
    return rows[0] ? toDelegation(rows[0]) : null;
  }

  async create(values: {
    delegatorUserId: string;
    delegateUserId: string;
    requestTypes: string[] | null;
    startDate: string;
    endDate: string;
  }): Promise<DelegationRow> {
    const row = await this.insertAudited({ ...values });
    return toDelegation(row as typeof approvalDelegations.$inferSelect);
  }

  async revoke(id: string, at: Date): Promise<boolean> {
    const row = await this.updateAudited(id, { revokedAt: at });
    return row !== null;
  }

  /**
   * The overlap rule reads rows that do not exist yet, so no row lock covers it
   * and no constraint expresses "these two `text[]` scopes intersect over these
   * two dates" — `gist` has no operator class for `text[] &&`. A transaction
   * advisory lock on the delegator is what remains, and it is the narrowest
   * thing that makes UC-APRV-006's 409 true rather than likely.
   */
  async lockDelegator(delegatorUserId: string): Promise<void> {
    const key = `${requireTenantContext().tenantId}:${delegatorUserId}`;
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

function toDelegation(row: typeof approvalDelegations.$inferSelect): DelegationRow {
  return {
    id: row.id,
    delegatorUserId: row.delegatorUserId,
    delegateUserId: row.delegateUserId,
    requestTypes: row.requestTypes,
    startDate: row.startDate,
    endDate: row.endDate,
    revokedAt: row.revokedAt,
  };
}
