import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNull, lte, or } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { rosterAssignments } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { AssignmentRepositoryPort } from '../domain/shift.ports';
import type { AssignmentRow } from '../domain/shift.types';

type AssignmentSelect = typeof rosterAssignments.$inferSelect;

@Injectable()
export class RosterAssignmentRepository
  extends TenantScopedRepository
  implements AssignmentRepositoryPort
{
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, rosterAssignments, audit);
  }

  async liveHistory(employeeId: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(and(eq(rosterAssignments.employeeId, employeeId), isNull(rosterAssignments.deletedAt)))
      .orderBy(rosterAssignments.effectiveFrom);
    return rows.map(toAssignment);
  }

  /** §7's history read: newest first, scheduled future rows included. */
  async history(employeeId: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(and(eq(rosterAssignments.employeeId, employeeId), isNull(rosterAssignments.deletedAt)))
      .orderBy(desc(rosterAssignments.effectiveFrom));
    return rows.map(toAssignment);
  }

  async companyDefaultHistory(companyId: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.companyId, companyId),
          isNull(rosterAssignments.employeeId),
          isNull(rosterAssignments.deletedAt),
        ),
      )
      .orderBy(desc(rosterAssignments.effectiveFrom));
    return rows.map(toAssignment);
  }

  async findById(id: string): Promise<AssignmentRow | null> {
    const row = await this.findRowById(id);
    return row ? toAssignment(row as AssignmentSelect) : null;
  }

  async liveOn(employeeId: string, date: string): Promise<AssignmentRow | null> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.employeeId, employeeId),
          isNull(rosterAssignments.deletedAt),
          asOf(date),
        ),
      );
    const row = rows[0];
    return row ? toAssignment(row) : null;
  }

  async liveOnForMany(employeeIds: string[], date: string): Promise<Map<string, AssignmentRow>> {
    if (employeeIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          inArray(rosterAssignments.employeeId, employeeIds),
          isNull(rosterAssignments.deletedAt),
          asOf(date),
        ),
      );
    return new Map(
      rows
        .filter((row) => row.employeeId)
        .map((row) => [row.employeeId as string, toAssignment(row)]),
    );
  }

  async overlapping(employeeId: string, from: string, to: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.employeeId, employeeId),
          isNull(rosterAssignments.deletedAt),
          overlaps(from, to),
        ),
      )
      .orderBy(rosterAssignments.effectiveFrom);
    return rows.map(toAssignment);
  }

  async defaultOn(companyId: string, date: string): Promise<AssignmentRow | null> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.companyId, companyId),
          isNull(rosterAssignments.employeeId),
          isNull(rosterAssignments.deletedAt),
          asOf(date),
        ),
      );
    const row = rows[0];
    return row ? toAssignment(row) : null;
  }

  async defaultsOverlapping(companyId: string, from: string, to: string): Promise<AssignmentRow[]> {
    const rows = await this.db
      .select()
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.companyId, companyId),
          isNull(rosterAssignments.employeeId),
          isNull(rosterAssignments.deletedAt),
          overlaps(from, to),
        ),
      )
      .orderBy(rosterAssignments.effectiveFrom);
    return rows.map(toAssignment);
  }

  /**
   * BR-SHF-007's supersede. Sequential awaits, never `Promise.all`: one
   * transaction is one connection (coding-standards-nestjs §4), and the close has
   * to land before the insert or the gist exclusion refuses the pair the planner
   * just made consistent.
   */
  async supersede(plan: {
    close: { id: string; effectiveTo: string } | null;
    insert: Omit<AssignmentRow, 'id'>;
  }): Promise<AssignmentRow> {
    if (plan.close) {
      await this.updateAudited(plan.close.id, { effectiveTo: plan.close.effectiveTo });
    }
    return toAssignment((await this.insertAudited({ ...plan.insert })) as AssignmentSelect);
  }

  async cancel(plan: {
    softDelete: string;
    reopen: { id: string; effectiveTo: string | null } | null;
  }): Promise<void> {
    await this.softDeleteAudited(plan.softDelete, this.clock.now());
    if (plan.reopen) {
      await this.updateAudited(plan.reopen.id, { effectiveTo: plan.reopen.effectiveTo });
    }
  }
}

/** database-conventions §5.3's as-of predicate, one implementation. */
function asOf(date: string) {
  return and(
    lte(rosterAssignments.effectiveFrom, date),
    or(isNull(rosterAssignments.effectiveTo), gt(rosterAssignments.effectiveTo, date)),
  );
}

/** Any row whose `[from, to)` interval intersects `[from, to)`. */
function overlaps(from: string, to: string) {
  return and(
    lte(rosterAssignments.effectiveFrom, to),
    or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, from)),
  );
}

function toAssignment(row: AssignmentSelect): AssignmentRow {
  return {
    id: row.id,
    companyId: row.companyId,
    employeeId: row.employeeId,
    patternId: row.patternId,
    cycleAnchorDate: row.cycleAnchorDate,
    note: row.note,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}
