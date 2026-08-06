import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { departments, positions } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { DepartmentRepositoryPort, Page, Paged } from '../domain/organization.ports';
import type { ArchiveBlocker, DepartmentRow } from '../domain/organization.types';

@Injectable()
export class DepartmentRepository
  extends TenantScopedRepository
  implements DepartmentRepositoryPort
{
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, departments, audit);
  }

  async list(filter: { companyId: string }, page: Page): Promise<Paged<DepartmentRow>> {
    const where = and(eq(departments.companyId, filter.companyId), isNull(departments.deletedAt));

    const rows = await this.db
      .select()
      .from(departments)
      .where(where)
      .orderBy(departments.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(departments).where(where);

    return { rows: rows.map(toDepartment), total: totals[0]?.total ?? 0 };
  }

  /**
   * The whole company's edge set. BR-ORG-004's cycle and depth checks walk it in
   * memory rather than in a recursive CTE: a company holds tens of departments,
   * the depth cap is 6, and the check runs on every re-parent — the read is
   * cheaper than the query plan, and the rule stays a testable pure function.
   */
  async listAll(companyId: string): Promise<DepartmentRow[]> {
    const rows = await this.db
      .select()
      .from(departments)
      .where(and(eq(departments.companyId, companyId), isNull(departments.deletedAt)));
    return rows.map(toDepartment);
  }

  async positionCounts(departmentIds: string[]): Promise<Map<string, number>> {
    const result = new Map(departmentIds.map((id) => [id, 0]));
    if (departmentIds.length === 0) return result;

    const rows = await this.db
      .select({ departmentId: positions.departmentId, total: count() })
      .from(positions)
      .where(and(inArray(positions.departmentId, departmentIds), isNull(positions.deletedAt)))
      .groupBy(positions.departmentId);

    for (const row of rows) result.set(row.departmentId, row.total);
    return result;
  }

  async findById(id: string): Promise<DepartmentRow | null> {
    const row = await this.findRowById(id);
    return row ? toDepartment(row as DepartmentSelect) : null;
  }

  async findByCode(companyId: string, code: string): Promise<DepartmentRow | null> {
    const rows = await this.db
      .select()
      .from(departments)
      .where(
        and(
          eq(departments.companyId, companyId),
          eq(departments.code, code),
          isNull(departments.deletedAt),
        ),
      );
    const row = rows[0];
    return row ? toDepartment(row) : null;
  }

  async create(values: Omit<DepartmentRow, 'id'>): Promise<DepartmentRow> {
    return toDepartment((await this.insertAudited({ ...values })) as DepartmentSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<DepartmentRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<DepartmentRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toDepartment(row as DepartmentSelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  async archiveBlockers(id: string): Promise<ArchiveBlocker[]> {
    const positionRows = await this.db
      .select({ total: count() })
      .from(positions)
      .where(and(eq(positions.departmentId, id), isNull(positions.deletedAt)));
    const childRows = await this.db
      .select({ total: count() })
      .from(departments)
      .where(and(eq(departments.parentDepartmentId, id), isNull(departments.deletedAt)));

    return [
      { type: 'position', count: positionRows[0]?.total ?? 0 },
      { type: 'child_department', count: childRows[0]?.total ?? 0 },
    ].filter((blocker) => blocker.count > 0);
  }

  /**
   * BR-ANN-002's targeting descends a department's subtree, and the walk is this
   * module's tree with this module's depth cap — which is the whole reason
   * `audienceEmployeeIds` lives here rather than in announcement (§13).
   */
  async descendantIds(departmentIds: string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];

    const rows = await this.db
      .select({ id: departments.id, parentDepartmentId: departments.parentDepartmentId })
      .from(departments)
      .where(isNull(departments.deletedAt));

    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentDepartmentId === null) continue;
      childrenOf.set(row.parentDepartmentId, [
        ...(childrenOf.get(row.parentDepartmentId) ?? []),
        row.id,
      ]);
    }

    const collected = new Set<string>();
    const queue = [...departmentIds];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || collected.has(current)) continue;
      collected.add(current);
      queue.push(...(childrenOf.get(current) ?? []));
    }
    return [...collected];
  }
}

type DepartmentSelect = typeof departments.$inferSelect;

function toDepartment(row: DepartmentSelect): DepartmentRow {
  return {
    id: row.id,
    companyId: row.companyId,
    parentDepartmentId: row.parentDepartmentId,
    code: row.code,
    name: row.name,
  };
}
