import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalChains } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type {
  ChainFilter,
  ChainRepositoryPort,
  ChainWrite,
  Page,
  Paged,
} from '../domain/approval.ports';
import type { ChainRow, Condition, StepConfig } from '../domain/approval.types';

/**
 * **Audited (channel 1)** — the reason this one extends the base and the
 * instance repositories do not.
 *
 * A chain is configuration: it decides who approves a payroll run, and editing
 * it is the same class of act as granting a role. BR-AUD-004 keeps the *trail*
 * out of the audit log because `approval_actions` already is one; it says
 * nothing about the configuration that produced the trail, and audit-log §4.2
 * had no `approval_*` row at all (A-196, hris-handbook PR #30).
 */
@Injectable()
export class ChainRepository extends TenantScopedRepository implements ChainRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, approvalChains, audit);
  }

  async list(filter: ChainFilter, page: Page): Promise<Paged<ChainRow>> {
    const where = and(this.live, ...this.filters(filter));

    const rows = await this.db
      .select()
      .from(approvalChains)
      .where(where)
      .orderBy(
        asc(approvalChains.requestType),
        asc(approvalChains.priority),
        asc(approvalChains.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ value: count() }).from(approvalChains).where(where);

    return { rows: rows.map(toChain), total: totals[0]?.value ?? 0 };
  }

  /**
   * BR-APRV-002's candidate set in one statement: this company's chains and the
   * tenant-wide ones. Selection orders and filters them (`chain-selection.ts`) —
   * the repository's job is to fetch neither more nor less than the rule reads.
   */
  async selectable(requestType: string, companyId: string): Promise<ChainRow[]> {
    const rows = await this.db
      .select()
      .from(approvalChains)
      .where(
        and(
          this.live,
          eq(approvalChains.requestType, requestType),
          or(eq(approvalChains.companyId, companyId), isNull(approvalChains.companyId)),
        ),
      );
    return rows.map(toChain);
  }

  async findById(id: string): Promise<ChainRow | null> {
    const row = await this.findRowById(id);
    return row ? toChain(row as ChainRecord) : null;
  }

  async siblings(requestType: string, companyId: string | null): Promise<ChainRow[]> {
    const rows = await this.db
      .select()
      .from(approvalChains)
      .where(
        and(
          this.live,
          eq(approvalChains.requestType, requestType),
          companyId === null
            ? isNull(approvalChains.companyId)
            : eq(approvalChains.companyId, companyId),
        ),
      );
    return rows.map(toChain);
  }

  async create(values: ChainWrite): Promise<ChainRow> {
    const row = await this.insertAudited({ ...values });
    return toChain(row as ChainRecord);
  }

  async update(id: string, patch: Partial<ChainWrite>): Promise<ChainRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toChain(row as ChainRecord) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  private filters(filter: ChainFilter): SQL[] {
    const predicates: SQL[] = [];
    if (filter.requestType) predicates.push(eq(approvalChains.requestType, filter.requestType));
    if (filter.companyId) predicates.push(eq(approvalChains.companyId, filter.companyId));
    // A company-scoped admin sees their companies' chains **and** the tenant-wide
    // ones, because a tenant-wide chain is what runs on their requests when no
    // company chain matches — hiding it would hide the rule they are subject to.
    if (filter.companyIds) {
      predicates.push(
        filter.companyIds.length === 0
          ? isNull(approvalChains.companyId)
          : (or(
              inArray(approvalChains.companyId, filter.companyIds),
              isNull(approvalChains.companyId),
            ) as SQL),
      );
    }
    return predicates;
  }
}

type ChainRecord = typeof approvalChains.$inferSelect;

function toChain(row: ChainRecord): ChainRow {
  return {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    name: row.name,
    priority: row.priority,
    conditions: (row.conditions ?? null) as Condition[] | null,
    steps: row.steps as StepConfig[],
    isActive: row.isActive,
  };
}
