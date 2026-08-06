import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import {
  departments,
  employees,
  jobLevels,
  orgAssignments,
  positions,
} from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type {
  Page,
  Paged,
  PositionFilter,
  PositionRepositoryPort,
} from '../domain/organization.ports';
import type { ArchiveBlocker, ChartNode, PositionRow } from '../domain/organization.types';
import { liveAssignmentAt } from './assignment-predicates';

/** BR-ORG-003: a holder is placed **and** employed — `resigned`/`terminated` are not. */
const EMPLOYED = ['active', 'on_leave'] as const;

@Injectable()
export class PositionRepository extends TenantScopedRepository implements PositionRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, positions, audit);
  }

  async list(filter: PositionFilter, page: Page, asOf: string): Promise<Paged<PositionRow>> {
    const where = and(
      eq(positions.companyId, filter.companyId),
      isNull(positions.deletedAt),
      filter.departmentId ? eq(positions.departmentId, filter.departmentId) : undefined,
      filter.jobLevelId ? eq(positions.jobLevelId, filter.jobLevelId) : undefined,
      filter.q
        ? or(ilike(positions.title, `%${filter.q}%`), ilike(positions.code, `%${filter.q}%`))
        : undefined,
      filter.vacant === undefined ? undefined : this.vacancy(filter.vacant, asOf),
    );

    const rows = await this.db
      .select()
      .from(positions)
      .where(where)
      .orderBy(positions.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(positions).where(where);

    return { rows: rows.map(toPosition), total: totals[0]?.total ?? 0 };
  }

  async listAll(companyId: string): Promise<PositionRow[]> {
    const rows = await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.companyId, companyId), isNull(positions.deletedAt)));
    return rows.map(toPosition);
  }

  async holderCounts(positionIds: string[], asOf: string): Promise<Map<string, number>> {
    const result = new Map(positionIds.map((id) => [id, 0]));
    if (positionIds.length === 0) return result;

    const rows = await this.db
      .select({ positionId: orgAssignments.positionId, total: count() })
      .from(orgAssignments)
      // A-194: joins `employees` directly until employee.md publishes
      // `employee_directory` (ADR-0001 rule 6). The employment filter cannot move
      // behind a port — it is a predicate inside an aggregate, not a page of rows.
      .innerJoin(employees, eq(employees.id, orgAssignments.employeeId))
      .where(
        and(
          inArray(orgAssignments.positionId, positionIds),
          liveAssignmentAt(asOf),
          inArray(employees.status, [...EMPLOYED]),
          isNull(employees.deletedAt),
        ),
      )
      .groupBy(orgAssignments.positionId);

    for (const row of rows) result.set(row.positionId, row.total);
    return result;
  }

  async findById(id: string): Promise<PositionRow | null> {
    const row = await this.findRowById(id);
    return row ? toPosition(row as PositionSelect) : null;
  }

  async findByCode(companyId: string, code: string): Promise<PositionRow | null> {
    const rows = await this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.companyId, companyId),
          eq(positions.code, code),
          isNull(positions.deletedAt),
        ),
      );
    const row = rows[0];
    return row ? toPosition(row) : null;
  }

  async create(values: Omit<PositionRow, 'id'>): Promise<PositionRow> {
    return toPosition((await this.insertAudited({ ...values })) as PositionSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<PositionRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<PositionRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toPosition(row as PositionSelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /**
   * BR-ORG-006: live **or future** holders, plus positions reporting to this one.
   * The second is why a manager's seat cannot be archived out from under the
   * chart — the subordinate rows would point at nothing and the reporting walk
   * would end on a dangling edge.
   */
  async archiveBlockers(id: string): Promise<ArchiveBlocker[]> {
    const today = this.today();
    const holderRows = await this.db
      .select({ total: count() })
      .from(orgAssignments)
      .where(
        and(
          eq(orgAssignments.positionId, id),
          isNull(orgAssignments.deletedAt),
          or(isNull(orgAssignments.effectiveTo), gt(orgAssignments.effectiveTo, today)),
        ),
      );
    const reportRows = await this.db
      .select({ total: count() })
      .from(positions)
      .where(and(eq(positions.reportsToPositionId, id), isNull(positions.deletedAt)));

    return [
      { type: 'holder', count: holderRows[0]?.total ?? 0 },
      { type: 'reporting_position', count: reportRows[0]?.total ?? 0 },
    ].filter((blocker) => blocker.count > 0);
  }

  /**
   * UC-ORG-006. Two queries, not one per node: the positions with their
   * department and level, then every live holder of them. Flat out with
   * `reportsToPositionId` edges — the client builds the forest (§7), which is
   * what makes `rootPositionId`/`depth` a slice of one payload rather than a
   * recursive query per expansion.
   *
   * Holders are **not** filtered to those with a user account here. BR-ORG-003's
   * account filter exists for approval resolution, where a manager who cannot log
   * in cannot approve; a holder without a login still occupies the seat, and a
   * chart that hid them would show a vacancy that is not one.
   */
  async chart(companyId: string, asOf: string): Promise<ChartNode[]> {
    const nodes = await this.db
      .select({
        positionId: positions.id,
        code: positions.code,
        title: positions.title,
        departmentId: positions.departmentId,
        departmentName: departments.name,
        jobLevelId: positions.jobLevelId,
        rank: jobLevels.rank,
        reportsToPositionId: positions.reportsToPositionId,
      })
      .from(positions)
      .innerJoin(departments, eq(departments.id, positions.departmentId))
      .innerJoin(jobLevels, eq(jobLevels.id, positions.jobLevelId))
      .where(and(eq(positions.companyId, companyId), isNull(positions.deletedAt)))
      .orderBy(positions.code);

    if (nodes.length === 0) return [];

    const holderRows = await this.db
      .select({
        positionId: orgAssignments.positionId,
        employeeId: employees.id,
        fullName: employees.fullName,
      })
      .from(orgAssignments)
      // A-194: see `holderCounts`.
      .innerJoin(employees, eq(employees.id, orgAssignments.employeeId))
      .where(
        and(
          inArray(
            orgAssignments.positionId,
            nodes.map((node) => node.positionId),
          ),
          liveAssignmentAt(asOf),
          inArray(employees.status, [...EMPLOYED]),
          isNull(employees.deletedAt),
        ),
      )
      .orderBy(employees.fullName);

    const holdersOf = new Map<string, { employeeId: string; fullName: string }[]>();
    for (const row of holderRows) {
      holdersOf.set(row.positionId, [
        ...(holdersOf.get(row.positionId) ?? []),
        { employeeId: row.employeeId, fullName: row.fullName },
      ]);
    }

    return nodes.map((node) => {
      const holders = holdersOf.get(node.positionId) ?? [];
      return { ...node, holders, vacant: holders.length === 0 };
    });
  }

  /** `?vacant=` — the same "is anyone in this seat" subquery, negated one way. */
  private vacancy(vacant: boolean, asOf: string): SQL {
    const held = exists(
      this.db
        .select({ one: sql`1` })
        .from(orgAssignments)
        .innerJoin(employees, eq(employees.id, orgAssignments.employeeId))
        .where(
          and(
            eq(orgAssignments.positionId, positions.id),
            liveAssignmentAt(asOf),
            inArray(employees.status, [...EMPLOYED]),
            isNull(employees.deletedAt),
          ),
        ),
    );
    return vacant ? not(held) : held;
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

type PositionSelect = typeof positions.$inferSelect;

function toPosition(row: PositionSelect): PositionRow {
  return {
    id: row.id,
    companyId: row.companyId,
    departmentId: row.departmentId,
    jobLevelId: row.jobLevelId,
    code: row.code,
    title: row.title,
    reportsToPositionId: row.reportsToPositionId,
  };
}
