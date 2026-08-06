import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { auditLogs } from '../../../database/schema';
import { anchorDayRange } from '../domain/audit-digest';
import type {
  AuditDiff,
  AuditLogFilter,
  AuditLogRow,
  AuditRepositoryPort,
  KeysetCursor,
  NewAuditLog,
} from '../domain/audit.ports';

/**
 * The append-only store.
 *
 * There is no `update` and no `delete` here, and that is not restraint — the
 * migration revokes both verbs from `hris_app` (BR-AUD-001), so a method for
 * either would be a method that raises `permission denied` at runtime. The
 * archive job's hard delete (UC-AUD-006) runs as a different role and will not
 * live on this class.
 *
 * Reads carry no tenant predicate: every call is inside the unit-of-work that
 * set `app.tenant_id`, and RLS is what scopes them (ADR-0002). Writes state the
 * tenant explicitly, where the policy's `WITH CHECK` re-verifies it.
 */
@Injectable()
export class AuditRepository implements AuditRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async append(entry: NewAuditLog): Promise<string> {
    const id = uuidv7();
    await this.connection.handle().insert(auditLogs).values({
      id,
      tenantId: entry.tenantId,
      occurredAt: entry.occurredAt,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId,
      impersonatorId: entry.impersonatorId,
      requestId: entry.requestId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      diff: entry.diff,
      metadata: entry.metadata,
      eventId: entry.eventId,
    });
    return id;
  }

  async findById(id: string): Promise<AuditLogRow | null> {
    const rows = await this.connection
      .handle()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.id, id));
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async list(
    filter: AuditLogFilter,
    page: { limit: number; after?: KeysetCursor },
  ): Promise<{ rows: AuditLogRow[]; hasMore: boolean }> {
    const conditions = buildFilter(filter);
    if (page.after) {
      // Row-value comparison, not `occurred_at < x OR (occurred_at = x AND id <
      // y)`: one expression the planner can drive straight off
      // `idx_audit_logs_cursor` backwards, and one that cannot be written with
      // the halves out of step.
      conditions.push(
        sql`(${auditLogs.occurredAt}, ${auditLogs.id}) < (${page.after.occurredAt}::timestamptz, ${page.after.id}::uuid)`,
      );
    }

    // One row past the page: the only way to answer `hasMore` without the count
    // ADR-0007 forbids on a cursor feed.
    const rows = await this.connection
      .handle()
      .select()
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(page.limit + 1);

    return { rows: rows.slice(0, page.limit).map(toRow), hasMore: rows.length > page.limit };
  }

  async listForAnchorDay(day: string): Promise<AuditLogRow[]> {
    const { fromId, toId } = anchorDayRange(day);
    const rows = await this.connection
      .handle()
      .select()
      .from(auditLogs)
      .where(and(gte(auditLogs.id, fromId), lt(auditLogs.id, toId)))
      .orderBy(asc(auditLogs.occurredAt), asc(auditLogs.id));
    return rows.map(toRow);
  }
}

function buildFilter(filter: AuditLogFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditLogs.entityId, filter.entityId));
  if (filter.actorUserId) conditions.push(eq(auditLogs.actorUserId, filter.actorUserId));
  if (filter.actorType) conditions.push(eq(auditLogs.actorType, filter.actorType));
  // Prefix, per §7 — `action=leave.` is a module's whole trail. `%` and `_` in
  // the input are escaped so a filter cannot become a wildcard scan.
  if (filter.action) conditions.push(like(auditLogs.action, `${escapeLike(filter.action)}%`));
  // `[from, to)` — half-open, so consecutive day ranges neither overlap nor gap.
  if (filter.from) conditions.push(gte(auditLogs.occurredAt, filter.from));
  if (filter.to) conditions.push(lt(auditLogs.occurredAt, filter.to));
  return conditions;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type AuditLogSelect = typeof auditLogs.$inferSelect;

function toRow(row: AuditLogSelect): AuditLogRow {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    impersonatorId: row.impersonatorId,
    requestId: row.requestId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    diff: row.diff as AuditDiff | null,
    metadata: row.metadata as Record<string, unknown> | null,
    eventId: row.eventId,
  };
}
