import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeStatusHistory } from '../../../database/schema';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type { NewStatusHistory, StatusHistoryRepositoryPort } from '../domain/employee.ports';
import type { StatusHistoryRow } from '../domain/employee.types';

/**
 * **Not on `TenantScopedRepository`, and that is the rule rather than an
 * oversight.** BR-EMP-011 keeps `employee_status_history` out of the channel-1
 * registry because *the history rows are themselves the trail* — every status
 * change already writes one, so auditing them would file a diff of the evidence
 * beside the evidence. The base class asserts registration in its constructor,
 * so extending it here would fail at module init, which is the gate working.
 *
 * The audit-relevant act is the `employees.status` write, and that one **is**
 * audited: it goes through `EmployeeRepository.setStatus`.
 */
@Injectable()
export class StatusHistoryRepository implements StatusHistoryRepositoryPort {
  constructor(
    private readonly connection: ConnectionProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.connection.handle();
  }

  async listFor(employeeId: string): Promise<StatusHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(employeeStatusHistory)
      .where(
        and(
          eq(employeeStatusHistory.employeeId, employeeId),
          isNull(employeeStatusHistory.deletedAt),
        ),
      )
      .orderBy(asc(employeeStatusHistory.effectiveDate), asc(employeeStatusHistory.id));
    return rows.map(toHistory);
  }

  async insert(row: NewStatusHistory): Promise<StatusHistoryRow> {
    const inserted = await this.db
      .insert(employeeStatusHistory)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        employeeId: row.employeeId,
        status: row.status,
        source: row.source,
        sourceId: row.sourceId ?? null,
        effectiveDate: row.effectiveDate,
        reason: row.reason ?? null,
        appliedAt: row.appliedAt ?? null,
        createdBy: currentRequestContext()?.userId,
        updatedBy: currentRequestContext()?.userId,
      })
      .returning();
    return toHistory(inserted[0] as typeof employeeStatusHistory.$inferSelect);
  }

  /**
   * UC-EMP-007's scan. **Effective-date order is load-bearing**: an employee may
   * hold a scheduled `on_leave` and a scheduled `resigned`, and applying them out
   * of order would leave the status reading `on_leave` after the person left.
   */
  async due(onOrBefore: string): Promise<StatusHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(employeeStatusHistory)
      .where(
        and(
          isNull(employeeStatusHistory.appliedAt),
          isNull(employeeStatusHistory.deletedAt),
          lte(employeeStatusHistory.effectiveDate, onOrBefore),
        ),
      )
      .orderBy(asc(employeeStatusHistory.effectiveDate), asc(employeeStatusHistory.id));
    return rows.map(toHistory);
  }

  /** §9 — one pending terminal transition at a time; retract before scheduling another. */
  async pendingTerminalFor(employeeId: string): Promise<StatusHistoryRow | null> {
    const rows = await this.db
      .select()
      .from(employeeStatusHistory)
      .where(
        and(
          eq(employeeStatusHistory.employeeId, employeeId),
          isNull(employeeStatusHistory.appliedAt),
          isNull(employeeStatusHistory.deletedAt),
          inArray(employeeStatusHistory.status, ['resigned', 'terminated']),
        ),
      )
      .limit(1);
    return rows[0] ? toHistory(rows[0]) : null;
  }

  async forSource(sourceId: string): Promise<StatusHistoryRow[]> {
    const rows = await this.db
      .select()
      .from(employeeStatusHistory)
      .where(
        and(eq(employeeStatusHistory.sourceId, sourceId), isNull(employeeStatusHistory.deletedAt)),
      )
      .orderBy(asc(employeeStatusHistory.effectiveDate));
    return rows.map(toHistory);
  }

  /**
   * The idempotency stamp of UC-EMP-007. Guarded by `applied_at IS NULL` so a
   * re-run of a crashed job cannot double-apply — the update touches zero rows
   * the second time.
   */
  async markApplied(id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(employeeStatusHistory)
      .set({ appliedAt: at, updatedBy: currentRequestContext()?.userId })
      .where(and(eq(employeeStatusHistory.id, id), isNull(employeeStatusHistory.appliedAt)))
      .returning({ id: employeeStatusHistory.id });
    return rows.length > 0;
  }

  async cancel(id: string): Promise<boolean> {
    const rows = await this.db
      .update(employeeStatusHistory)
      .set({
        deletedAt: this.clock.now(),
        deletedBy: currentRequestContext()?.userId,
      })
      .where(
        and(
          eq(employeeStatusHistory.id, id),
          isNull(employeeStatusHistory.appliedAt),
          isNull(employeeStatusHistory.deletedAt),
        ),
      )
      .returning({ id: employeeStatusHistory.id });
    return rows.length > 0;
  }
}

function toHistory(row: typeof employeeStatusHistory.$inferSelect): StatusHistoryRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    source: row.source,
    sourceId: row.sourceId,
    effectiveDate: row.effectiveDate,
    reason: row.reason,
    appliedAt: row.appliedAt,
  };
}
