import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt, ilike, inArray, isNull, or } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { branches, orgAssignments } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { BranchRepositoryPort, Page, Paged } from '../domain/organization.ports';
import type { ArchiveBlocker, BranchRow } from '../domain/organization.types';

@Injectable()
export class BranchRepository extends TenantScopedRepository implements BranchRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, branches, audit);
  }

  async list(filter: { companyId: string; q?: string }, page: Page): Promise<Paged<BranchRow>> {
    const where = and(
      eq(branches.companyId, filter.companyId),
      isNull(branches.deletedAt),
      filter.q
        ? or(ilike(branches.name, `%${filter.q}%`), ilike(branches.code, `%${filter.q}%`))
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(branches)
      .where(where)
      .orderBy(branches.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(branches).where(where);

    return { rows: rows.map(toBranch), total: totals[0]?.total ?? 0 };
  }

  async assignmentCounts(branchIds: string[]): Promise<Map<string, number>> {
    const result = new Map(branchIds.map((id) => [id, 0]));
    if (branchIds.length === 0) return result;

    const rows = await this.db
      .select({ branchId: orgAssignments.branchId, total: count() })
      .from(orgAssignments)
      .where(and(inArray(orgAssignments.branchId, branchIds), isNull(orgAssignments.deletedAt)))
      .groupBy(orgAssignments.branchId);

    for (const row of rows) result.set(row.branchId, row.total);
    return result;
  }

  async findById(id: string): Promise<BranchRow | null> {
    const row = await this.findRowById(id);
    return row ? toBranch(row as BranchSelect) : null;
  }

  async findByCode(companyId: string, code: string): Promise<BranchRow | null> {
    const rows = await this.db
      .select()
      .from(branches)
      .where(
        and(eq(branches.companyId, companyId), eq(branches.code, code), isNull(branches.deletedAt)),
      );
    const row = rows[0];
    return row ? toBranch(row) : null;
  }

  async create(values: Omit<BranchRow, 'id'>): Promise<BranchRow> {
    return toBranch((await this.insertAudited({ ...values })) as BranchSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<BranchRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<BranchRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toBranch(row as BranchSelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /**
   * BR-ORG-006: live **or future** assignments block. A scheduled transfer into
   * a branch is a commitment already made, and archiving out from under it would
   * leave a placement pointing at a branch that no longer exists on the day it
   * takes effect.
   */
  async archiveBlockers(id: string): Promise<ArchiveBlocker[]> {
    const today = this.clock.now().toISOString().slice(0, 10);
    const rows = await this.db
      .select({ total: count() })
      .from(orgAssignments)
      .where(
        and(
          eq(orgAssignments.branchId, id),
          isNull(orgAssignments.deletedAt),
          or(isNull(orgAssignments.effectiveTo), gt(orgAssignments.effectiveTo, today)),
        ),
      );

    const total = rows[0]?.total ?? 0;
    return total > 0 ? [{ type: 'assignment', count: total }] : [];
  }
}

type BranchSelect = typeof branches.$inferSelect;

function toBranch(row: BranchSelect): BranchRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}
