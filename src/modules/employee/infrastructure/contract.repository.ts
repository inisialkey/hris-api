import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeContracts } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { ContractRepositoryPort } from '../domain/employee.ports';
import type { ContractRow } from '../domain/employee.types';

/**
 * BR-EMP-007's table. Overlap is the database's job (`excl_employee_contracts_no_overlap`)
 * and surfaces as `EMP_CONTRACT_OVERLAP` — pre-checking it here would lose the
 * race against a second admin renewing the same employee, which is exactly what
 * the constraint exists for.
 */
@Injectable()
export class ContractRepository extends TenantScopedRepository implements ContractRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, employeeContracts, audit);
  }

  async listFor(employeeId: string): Promise<ContractRow[]> {
    const rows = await this.db
      .select()
      .from(employeeContracts)
      .where(and(eq(employeeContracts.employeeId, employeeId), isNull(employeeContracts.deletedAt)))
      .orderBy(desc(employeeContracts.startDate), desc(employeeContracts.id));
    return rows.map(toContract);
  }

  async findById(id: string): Promise<ContractRow | null> {
    const row = await this.findRowById(id);
    return row ? toContract(row as typeof employeeContracts.$inferSelect) : null;
  }

  /**
   * The contract covering `date`, **inclusive of `end_date`** — the same
   * `'[]'` semantics the exclusion constraint uses. A PKWTT row (NULL end) is
   * open-ended, so it covers every date from its start.
   */
  async currentAt(employeeId: string, date: string): Promise<ContractRow | null> {
    const rows = await this.db
      .select()
      .from(employeeContracts)
      .where(
        and(
          eq(employeeContracts.employeeId, employeeId),
          isNull(employeeContracts.deletedAt),
          lte(employeeContracts.startDate, date),
          or(isNull(employeeContracts.endDate), sql`${employeeContracts.endDate} >= ${date}::date`),
        ),
      )
      .orderBy(desc(employeeContracts.startDate))
      .limit(1);
    return rows[0] ? toContract(rows[0]) : null;
  }

  /**
   * The same predicate as `currentAt`, over a page of employees in one
   * statement. `DISTINCT ON` picks the newest covering row per employee, which
   * is the tie-break `currentAt`'s `ORDER BY … LIMIT 1` makes for a single one.
   */
  async currentAtBatch(employeeIds: string[], date: string): Promise<Map<string, ContractRow>> {
    if (employeeIds.length === 0) return new Map();

    const rows = await this.db
      .select()
      .from(employeeContracts)
      .where(
        and(
          inArray(employeeContracts.employeeId, employeeIds),
          isNull(employeeContracts.deletedAt),
          lte(employeeContracts.startDate, date),
          or(isNull(employeeContracts.endDate), sql`${employeeContracts.endDate} >= ${date}::date`),
        ),
      )
      .orderBy(employeeContracts.employeeId, desc(employeeContracts.startDate));

    const byEmployee = new Map<string, ContractRow>();
    for (const row of rows) {
      if (!byEmployee.has(row.employeeId)) byEmployee.set(row.employeeId, toContract(row));
    }
    return byEmployee;
  }

  async create(
    values: Omit<ContractRow, 'id' | 'lastRemindedDays' | 'createdBy'>,
  ): Promise<ContractRow> {
    const row = await this.insertAudited({
      employeeId: values.employeeId,
      kind: values.kind,
      startDate: values.startDate,
      endDate: values.endDate,
      fileId: values.fileId,
      note: values.note,
    });
    return toContract(row as typeof employeeContracts.$inferSelect);
  }

  async update(
    id: string,
    patch: Partial<Pick<ContractRow, 'startDate' | 'endDate' | 'fileId' | 'note'>>,
  ): Promise<ContractRow | null> {
    const row = await this.updateAudited(id, patch);
    return row ? toContract(row as typeof employeeContracts.$inferSelect) : null;
  }

  async softDelete(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  async countFor(employeeId: string): Promise<number> {
    const rows = await this.db
      .select({ total: count() })
      .from(employeeContracts)
      .where(
        and(eq(employeeContracts.employeeId, employeeId), isNull(employeeContracts.deletedAt)),
      );
    return rows[0]?.total ?? 0;
  }
}

function toContract(row: typeof employeeContracts.$inferSelect): ContractRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    kind: row.kind,
    startDate: row.startDate,
    endDate: row.endDate,
    fileId: row.fileId,
    note: row.note,
    lastRemindedDays: row.lastRemindedDays,
    createdBy: row.createdBy,
  };
}
