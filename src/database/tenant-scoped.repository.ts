import { and, eq, getTableName, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

import { assertAuditedTable, type AuditChangePort } from '../modules/audit';
import { currentRequestContext, requireTenantContext } from '../shared/context';
import { ConnectionProvider } from './connection.provider';

/**
 * The base every audited tenant table's repository extends — audit-log §4.2's
 * hook, and the reason channel 1 (BR-AUD-002) cannot be forgotten by a module
 * that writes a row.
 *
 * Three properties, none of which a subclass can opt out of:
 *
 * **Registered or dead.** The constructor asserts the table has a §4.2 entry
 * (BR-AUD-005, amended 2026-08-06). A table nobody classified fails at module
 * init, not in a diff that already shipped.
 *
 * **Atomic with the change.** The audit insert runs on the same handle inside the
 * same unit-of-work, so it commits with the mutation or rolls back with it. No
 * lost audits on crash, no phantom rows on rollback.
 *
 * **Before-images are read, not guessed.** An update selects the row first. The
 * handbook expects the optimistic-lock read to supply it for free; these tables
 * carry no `version` column (organization.md §4.1 — nothing here is
 * offline-mutable), so the read is explicit. Single-row admin mutations, one
 * extra select.
 *
 * No tenant predicate on reads: RLS supplies it (ADR-0002). Writes state the
 * tenant so the policy's `WITH CHECK` re-verifies it.
 */
export abstract class TenantScopedRepository {
  protected constructor(
    protected readonly connection: ConnectionProvider,
    protected readonly table: PgTable,
    private readonly audit: AuditChangePort,
  ) {
    assertAuditedTable(getTableName(table));
  }

  protected get db() {
    return this.connection.handle();
  }

  /**
   * `deleted_at IS NULL`, the live-row predicate every read here starts from —
   * **or `true` on a table that has no such column.** Not every audited table
   * soft-deletes: `approval_delegations` ends through `revoked_at` (§4), which is
   * an update rather than a deletion, and the alternative to this branch was
   * adding a `deleted_at` nothing writes just to satisfy a base class.
   */
  protected get live(): SQL {
    const deletedAt = columns(this.table).deletedAt;
    return deletedAt ? isNull(deletedAt) : sql`true`;
  }

  protected byId(id: string): SQL {
    return eq(columns(this.table).id, id);
  }

  protected async findRowById(id: string): Promise<Record<string, unknown> | null> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(and(this.byId(id), this.live));
    return rows[0] ?? null;
  }

  protected async insertAudited(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = uuidv7();

    // `returning()` rather than echoing the input: defaults and coercions happen
    // in the database (`numeric` comes back a string, `now()` is the server's),
    // and a diff of what the caller *sent* would not be a record of what was
    // stored. Sequential awaits, never `Promise.all` — one transaction is one
    // socket (coding-standards-nestjs §4).
    const inserted = await this.db
      .insert(this.table)
      .values({
        ...values,
        id,
        tenantId: requireTenantContext().tenantId,
        createdBy: actor(),
        updatedBy: actor(),
      } as never)
      .returning();
    const row = inserted[0] as Record<string, unknown>;

    await this.audit.recordChange({
      table: this.table,
      action: 'created',
      entityId: id,
      after: row,
    });
    return row;
  }

  /**
   * Returns `null` when no live row has that id — which is every out-of-scope and
   * every already-archived case, and the caller turns it into a 404 rather than
   * telling an unauthorized reader that the row exists (api-standards §4).
   */
  protected async updateAudited(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const before = await this.findRowById(id);
    if (!before) return null;

    const updated = await this.db
      .update(this.table)
      .set({ ...patch, updatedBy: actor() })
      .where(and(this.byId(id), this.live))
      .returning();
    const after = updated[0] as Record<string, unknown>;

    await this.audit.recordChange({
      table: this.table,
      action: 'updated',
      entityId: id,
      before,
      after,
    });
    return after;
  }

  /**
   * Soft delete — BR-ORG-006's archive, and the same act for every other module
   * whose tables carry `deleted_at`. A hard delete would take the row's history
   * with it, and §4.2 registers these tables precisely so that history survives.
   */
  protected async softDeleteAudited(id: string, at: Date): Promise<Record<string, unknown> | null> {
    const before = await this.findRowById(id);
    if (!before) return null;

    await this.db
      .update(this.table)
      .set({ deletedAt: at, deletedBy: actor() })
      .where(and(this.byId(id), this.live));

    await this.audit.recordChange({
      table: this.table,
      action: 'deleted',
      entityId: id,
      before,
    });
    return before;
  }
}

/** The audit-column contract every table on this base satisfies (`_shared.ts`). */
interface SharedColumns {
  id: PgTable['_']['columns'][string];
  deletedAt?: PgTable['_']['columns'][string];
}

function columns(table: PgTable): SharedColumns {
  return table as unknown as SharedColumns;
}

function actor(): string | undefined {
  return currentRequestContext()?.userId;
}
