import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import {
  branches,
  companies,
  departments,
  employeeDirectory,
  jobLevels,
  orgAssignments,
  positions,
} from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { AssignmentHistoryRow, AssignmentRepositoryPort } from '../domain/organization.ports';
import type { AssignmentRow, Placement } from '../domain/organization.types';
import { liveAssignmentAt } from './assignment-predicates';

/** BR-ORG-003: a holder is placed **and** employed. */
const EMPLOYED = ['active', 'on_leave'] as const;

@Injectable()
export class AssignmentRepository
  extends TenantScopedRepository
  implements AssignmentRepositoryPort
{
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, orgAssignments, audit);
  }

  async liveHistory(employeeId: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(orgAssignments)
      .where(and(eq(orgAssignments.employeeId, employeeId), isNull(orgAssignments.deletedAt)))
      .orderBy(orgAssignments.effectiveFrom);
    return rows.map(toAssignment);
  }

  /** §7's history: cancelled rows stay visible and flagged, which is why it is a soft delete. */
  async fullHistory(employeeId: string): Promise<AssignmentHistoryRow[]> {
    const rows = await this.db
      .select({
        assignment: orgAssignments,
        positionTitle: positions.title,
        branchName: branches.name,
      })
      .from(orgAssignments)
      .innerJoin(positions, eq(positions.id, orgAssignments.positionId))
      .innerJoin(branches, eq(branches.id, orgAssignments.branchId))
      .where(eq(orgAssignments.employeeId, employeeId))
      .orderBy(desc(orgAssignments.effectiveFrom), desc(orgAssignments.id));

    return rows.map((row) => ({
      ...toAssignment(row.assignment),
      positionTitle: row.positionTitle,
      branchName: row.branchName,
      cancelled: row.assignment.deletedAt !== null,
      createdBy: row.assignment.createdBy,
      createdAt: row.assignment.createdAt,
    }));
  }

  async findById(id: string): Promise<AssignmentRow | null> {
    const row = await this.findRowById(id);
    return row ? toAssignment(row as AssignmentSelect) : null;
  }

  async placement(employeeId: string, asOf: string): Promise<Placement | null> {
    const rows = await this.placementQuery(
      and(eq(orgAssignments.employeeId, employeeId), liveAssignmentAt(asOf)),
    );
    return rows[0]?.placement ?? null;
  }

  async placements(employeeIds: string[], asOf: string): Promise<Map<string, Placement>> {
    const result = new Map<string, Placement>();
    if (employeeIds.length === 0) return result;

    const rows = await this.placementQuery(
      and(inArray(orgAssignments.employeeId, employeeIds), liveAssignmentAt(asOf)),
    );
    for (const row of rows) result.set(row.employeeId, row.placement);
    return result;
  }

  /**
   * BR-ORG-003's holder rule in full: live placement, employed, **and** a linked
   * user account. The account is not decoration — the caller is the approval
   * engine assigning a step, and a manager with no login cannot act on one.
   */
  async holderUserIds(
    positionIds: string[],
    asOf: string,
    excludeEmployeeId?: string,
  ): Promise<string[]> {
    if (positionIds.length === 0) return [];

    const rows = await this.db
      .selectDistinct({ userId: employeeDirectory.userId })
      .from(orgAssignments)
      // ADR-0001 rule 6's published view. `security_invoker = true` on it means
      // this join runs under the caller's RLS, so the tenant predicate is the
      // same one the base table would have applied.
      .innerJoin(employeeDirectory, eq(employeeDirectory.employeeId, orgAssignments.employeeId))
      .where(
        and(
          inArray(orgAssignments.positionId, positionIds),
          liveAssignmentAt(asOf),
          inArray(employeeDirectory.status, [...EMPLOYED]),
          isNotNull(employeeDirectory.userId),
          excludeEmployeeId ? ne(orgAssignments.employeeId, excludeEmployeeId) : undefined,
        ),
      );

    return rows.map((row) => row.userId).filter((id): id is string => id !== null);
  }

  /** `directReports`' projection: employed holders, account or not (A-195). */
  async holderEmployeeIds(
    positionIds: string[],
    asOf: string,
    excludeEmployeeId?: string,
  ): Promise<string[]> {
    if (positionIds.length === 0) return [];

    const rows = await this.db
      .selectDistinct({ employeeId: orgAssignments.employeeId })
      .from(orgAssignments)
      // ADR-0001 rule 6's published view. `security_invoker = true` on it means
      // this join runs under the caller's RLS, so the tenant predicate is the
      // same one the base table would have applied.
      .innerJoin(employeeDirectory, eq(employeeDirectory.employeeId, orgAssignments.employeeId))
      .where(
        and(
          inArray(orgAssignments.positionId, positionIds),
          liveAssignmentAt(asOf),
          inArray(employeeDirectory.status, [...EMPLOYED]),
          excludeEmployeeId ? ne(orgAssignments.employeeId, excludeEmployeeId) : undefined,
        ),
      );

    return rows.map((row) => row.employeeId);
  }

  /**
   * BR-ANN-002's audience, resolved over placement. The dimensions **union**:
   * "Finance" plus "Jakarta branch" is both groups, not their intersection — a
   * targeting rule adds an audience, it does not narrow one. No dimension at all
   * means everyone in scope, which is the tenant-wide announcement.
   *
   * `departmentIds` arrives already expanded to its subtree: the walk is the
   * department tree's and belongs to that repository (§13).
   */
  async audienceEmployeeIds(
    rules: {
      companyId: string | null;
      branchIds?: string[];
      departmentIds?: string[];
      positionIds?: string[];
      jobLevelIds?: string[];
    },
    asOf: string,
  ): Promise<string[]> {
    const dimensions: SQL[] = [];
    if (rules.branchIds?.length) dimensions.push(inArray(orgAssignments.branchId, rules.branchIds));
    if (rules.departmentIds?.length) {
      dimensions.push(inArray(positions.departmentId, rules.departmentIds));
    }
    if (rules.positionIds?.length) {
      dimensions.push(inArray(orgAssignments.positionId, rules.positionIds));
    }
    if (rules.jobLevelIds?.length) {
      dimensions.push(inArray(positions.jobLevelId, rules.jobLevelIds));
    }

    const rows = await this.db
      .selectDistinct({ employeeId: orgAssignments.employeeId })
      .from(orgAssignments)
      .innerJoin(positions, eq(positions.id, orgAssignments.positionId))
      // The published view again — see `holderUserIds`.
      .innerJoin(employeeDirectory, eq(employeeDirectory.employeeId, orgAssignments.employeeId))
      .where(
        and(
          liveAssignmentAt(asOf),
          inArray(employeeDirectory.status, [...EMPLOYED]),
          rules.companyId === null ? undefined : eq(positions.companyId, rules.companyId),
          dimensions.length > 0 ? or(...dimensions) : undefined,
        ),
      );

    return rows.map((row) => row.employeeId);
  }

  /**
   * BR-ORG-008's supersede. One repository call because it is one act: the
   * predecessor stops covering the successor's start **before** the successor
   * claims it, or the exclusion constraint refuses the insert. Callers never
   * write the two rows independently (database-conventions §5 rule 4).
   */
  async supersede(
    employeeId: string,
    plan: {
      close: { id: string; effectiveTo: string } | null;
      insert: Omit<AssignmentRow, 'id' | 'employeeId'>;
    },
  ): Promise<AssignmentRow> {
    if (plan.close) {
      await this.updateAudited(plan.close.id, { effectiveTo: plan.close.effectiveTo });
    }
    const row = await this.insertAudited({ ...plan.insert, employeeId });
    return toAssignment(row as AssignmentSelect);
  }

  /**
   * UC-ORG-004. Soft-delete first: reopening the predecessor while the scheduled
   * row still occupies the range makes the two intervals overlap, and the
   * constraint is right to refuse that.
   */
  async cancel(plan: {
    softDelete: string;
    reopen: { id: string; effectiveTo: string | null } | null;
  }): Promise<void> {
    await this.softDeleteAudited(plan.softDelete, this.clock.now());
    if (plan.reopen) {
      await this.updateAudited(plan.reopen.id, { effectiveTo: plan.reopen.effectiveTo });
    }
  }

  async closeLiveAt(employeeId: string, date: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: orgAssignments.id })
      .from(orgAssignments)
      .where(and(eq(orgAssignments.employeeId, employeeId), liveAssignmentAt(date)));

    const live = rows[0];
    if (!live) return false;

    await this.updateAudited(live.id, { effectiveTo: date });
    return true;
  }

  private async placementQuery(
    where: SQL | undefined,
  ): Promise<{ employeeId: string; placement: Placement }[]> {
    const rows = await this.db
      .select({
        employeeId: orgAssignments.employeeId,
        companyId: positions.companyId,
        companyName: companies.name,
        branchId: branches.id,
        branchName: branches.name,
        branchTimezone: branches.timezone,
        departmentId: positions.departmentId,
        departmentName: departments.name,
        positionId: positions.id,
        positionTitle: positions.title,
        jobLevelId: positions.jobLevelId,
        jobLevelName: jobLevels.name,
      })
      .from(orgAssignments)
      .innerJoin(positions, eq(positions.id, orgAssignments.positionId))
      .innerJoin(branches, eq(branches.id, orgAssignments.branchId))
      // Three joins added with the display names (A-195). All inner: a position
      // cannot exist without its department, job level, or company — the FKs say
      // so — so none of them can turn a placement into no placement.
      .innerJoin(departments, eq(departments.id, positions.departmentId))
      .innerJoin(jobLevels, eq(jobLevels.id, positions.jobLevelId))
      .innerJoin(companies, eq(companies.id, positions.companyId))
      .where(where);

    return rows.map(({ employeeId, ...placement }) => ({ employeeId, placement }));
  }
}

type AssignmentSelect = typeof orgAssignments.$inferSelect;

function toAssignment(row: AssignmentSelect): AssignmentRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    positionId: row.positionId,
    branchId: row.branchId,
    kind: row.kind,
    note: row.note,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}
