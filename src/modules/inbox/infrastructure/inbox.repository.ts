import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { inboxItems } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { InboxRepositoryPort, NewInboxItem } from '../domain/inbox.ports';
import type {
  ClosedReason,
  InboxItemRow,
  InboxListItem,
  InboxListQuery,
  SourceRef,
  TitleParams,
} from '../domain/inbox.types';

type InboxSelect = typeof inboxItems.$inferSelect;

/**
 * **Not on `TenantScopedRepository`** — `inbox_items` has no audit-log §4.2
 * entry, so the base's constructor assertion would fail at module init, and it
 * should: the table is a navigation layer over facts audited where they
 * happened.
 *
 * No tenant predicate on reads: RLS supplies it (ADR-0002). Writes state the
 * tenant so the policy's `WITH CHECK` re-verifies it.
 */
@Injectable()
export class InboxRepository implements InboxRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  /**
   * BR-INB-004, enforced by `uq_inbox_items_dedupe` rather than by a read.
   * `ON CONFLICT DO NOTHING` returns only the rows that were new, so a
   * redelivered handler job is a no-op with no race window — the check and the
   * write are one statement.
   */
  async insertIfNew(items: readonly NewInboxItem[]): Promise<number> {
    if (items.length === 0) return 0;

    const tenantId = requireTenantContext().tenantId;
    const inserted = await this.db
      .insert(inboxItems)
      .values(
        items.map((item) => ({
          id: uuidv7(),
          tenantId,
          userId: item.userId,
          type: item.type,
          dedupeKey: item.dedupeKey,
          title: item.title,
          subtitle: item.subtitle,
          params: item.params,
          sourceRef: item.sourceRef,
          deepLink: item.deepLink,
          dueAt: item.dueAt,
        })),
      )
      .onConflictDoNothing({
        target: [inboxItems.tenantId, inboxItems.userId, inboxItems.dedupeKey],
      })
      .returning({ id: inboxItems.id });

    return inserted.length;
  }

  async list(
    userId: string,
    query: InboxListQuery,
  ): Promise<{ rows: InboxListItem[]; hasMore: boolean }> {
    const conditions = [eq(inboxItems.userId, userId), eq(inboxItems.status, query.status)];
    if (query.type) conditions.push(eq(inboxItems.type, query.type));
    if (query.after) {
      // Row-value comparison rather than `created_at < x OR (created_at = x AND
      // id < y)`: one expression the planner drives straight off
      // `idx_inbox_items_list` backwards, and one that cannot be written with
      // the halves out of step.
      conditions.push(
        sql`(${inboxItems.createdAt}, ${inboxItems.id}) < (${query.after.createdAt.toISOString()}::timestamptz, ${query.after.id}::uuid)`,
      );
    }

    // One row past the page: the only way to answer `hasMore` without the count
    // ADR-0007 forbids on a cursor feed.
    const rows = await this.db
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
      .limit(query.limit + 1);

    return { rows: rows.slice(0, query.limit).map(toListItem), hasMore: rows.length > query.limit };
  }

  /** BR-INB-003 — `open` only, and `seen_at` is not in the predicate. */
  async openCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(inboxItems)
      .where(and(eq(inboxItems.userId, userId), eq(inboxItems.status, 'open')));
    return rows[0]?.value ?? 0;
  }

  async findOwned(userId: string, id: string): Promise<InboxItemRow | null> {
    const rows = await this.db
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.id, id), eq(inboxItems.userId, userId)));
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * The `seen_at IS NULL` predicate is what makes a second call a no-op rather
   * than a re-stamp — §7 has no unsee, and a mark that moves its own timestamp
   * is not idempotent. The cosmetic replay lane (offline-sync §10) re-sends
   * these fire-and-forget on reconnect, so a second call is the normal case.
   */
  async markSeen(userId: string, id: string, at: Date): Promise<{ seenAt: Date } | null> {
    const updated = await this.db
      .update(inboxItems)
      .set({ seenAt: at })
      .where(and(eq(inboxItems.id, id), eq(inboxItems.userId, userId), isNull(inboxItems.seenAt)))
      .returning({ seenAt: inboxItems.seenAt });

    const stamped = updated[0]?.seenAt;
    if (stamped) return { seenAt: stamped };

    // Already seen, or not this user's row. The caller cannot tell the two apart
    // from here and must not — one is a success and the other is a 404.
    const existing = await this.db
      .select({ seenAt: inboxItems.seenAt })
      .from(inboxItems)
      .where(and(eq(inboxItems.id, id), eq(inboxItems.userId, userId)));

    const already = existing[0]?.seenAt;
    return already ? { seenAt: already } : null;
  }

  async markAllSeen(userId: string, at: Date): Promise<number> {
    const updated = await this.db
      .update(inboxItems)
      .set({ seenAt: at })
      .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.seenAt)))
      .returning({ id: inboxItems.id });
    return updated.length;
  }

  /**
   * The `user_id` predicate is redundant against the caller, which read the row
   * with `findOwned` first — and it is here anyway, because a method that can
   * complete any row in the tenant is a footgun aimed at the next caller rather
   * than at this one.
   */
  async complete(userId: string, id: string, at: Date): Promise<{ doneAt: Date } | null> {
    const updated = await this.db
      .update(inboxItems)
      .set({ status: 'done', doneAt: at })
      .where(
        and(eq(inboxItems.id, id), eq(inboxItems.userId, userId), eq(inboxItems.status, 'open')),
      )
      .returning({ doneAt: inboxItems.doneAt });

    const stamped = updated[0]?.doneAt;
    return stamped ? { doneAt: stamped } : null;
  }

  async completeByDedupeKey(userId: string, dedupeKey: string, at: Date): Promise<number> {
    const updated = await this.db
      .update(inboxItems)
      .set({ status: 'done', doneAt: at })
      .where(
        and(
          eq(inboxItems.userId, userId),
          eq(inboxItems.dedupeKey, dedupeKey),
          eq(inboxItems.status, 'open'),
        ),
      )
      .returning({ id: inboxItems.id });
    return updated.length;
  }

  /**
   * BR-INB-006's two closure shapes, one statement.
   *
   * The predicate reads `source_ref` keys, which database-conventions §1.8
   * forbids filtering on and which §4 nonetheless makes the contract — resolved
   * with `idx_inbox_items_source_open`, a partial expression index over exactly
   * these two extractions (A-199, hris-handbook PR #33). Partial on `open`
   * because a `done` item is somebody's completed work and never closes.
   */
  async closeApprovalItems(
    instanceId: string,
    stepId: string | null,
    reason: ClosedReason,
  ): Promise<number> {
    const conditions = [
      eq(inboxItems.status, 'open'),
      sql`${inboxItems.sourceRef}->>'instanceId' = ${instanceId}`,
    ];
    if (stepId) conditions.push(sql`${inboxItems.sourceRef}->>'stepId' = ${stepId}`);

    const updated = await this.db
      .update(inboxItems)
      .set({ status: 'closed', closedReason: reason })
      .where(and(...conditions))
      .returning({ id: inboxItems.id });
    return updated.length;
  }

  /**
   * UC-INB-005's retraction. Keyed on `dedupe_key`, which BR-INB-004 makes the
   * announcement id for every one of its items.
   *
   * `uq_inbox_items_dedupe` leads with `(tenant_id, user_id)`, so this bounds
   * the scan to one tenant rather than seeking the rows directly. Left as a scan
   * deliberately: a retraction is a rare admin act that already writes one row
   * per recipient, and a third partial index on this table would be paid for on
   * every materialization. Add `(tenant_id, dedupe_key) WHERE status = 'open'`
   * if retraction latency ever shows up in p95.
   */
  async closeByDedupeKey(dedupeKey: string, reason: ClosedReason): Promise<number> {
    const updated = await this.db
      .update(inboxItems)
      .set({ status: 'closed', closedReason: reason })
      .where(and(eq(inboxItems.dedupeKey, dedupeKey), eq(inboxItems.status, 'open')))
      .returning({ id: inboxItems.id });
    return updated.length;
  }

  /**
   * BR-INB-010 — *"`open` items never purge"*, which is the `ne` below and the
   * whole rule: a pending task must not silently vanish, and a stuck instance is
   * the engine's problem to surface (BR-APRV-006).
   *
   * The window is measured from `created_at` because it is the only stamp every
   * non-`open` item has: §4 gives a `done` item `done_at` and a `closed` one
   * nothing but its reason, so measuring from the ending would leave half the
   * set unmeasurable. The rule says *"after `inbox.retention_days` once
   * non-`open`"* without naming the origin, and `notifications` purges on the
   * same basis.
   */
  async deleteClosedBefore(cutoff: Date, limit: number): Promise<number> {
    const doomed = await this.db
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(ne(inboxItems.status, 'open'), lt(inboxItems.createdAt, cutoff)))
      .limit(limit);

    if (doomed.length === 0) return 0;

    // The count comes from the `DELETE`, not from the `SELECT` that chose the
    // batch: two concurrent runs would otherwise both report rows only one of
    // them removed, and a purge that overstates what it deleted is the one
    // number nobody can check afterwards.
    const removed = await this.db
      .delete(inboxItems)
      .where(
        inArray(
          inboxItems.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: inboxItems.id });
    return removed.length;
  }
}

function toRow(row: InboxSelect): InboxItemRow {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    status: row.status,
    dedupeKey: row.dedupeKey,
    title: row.title,
    subtitle: row.subtitle,
    params: row.params as TitleParams,
    sourceRef: row.sourceRef as SourceRef,
    deepLink: row.deepLink,
    dueAt: row.dueAt,
    seenAt: row.seenAt,
    doneAt: row.doneAt,
    closedReason: row.closedReason as ClosedReason | null,
    createdAt: row.createdAt,
  };
}

/** §7's list row — no `sourceRef`, no `params`; both are plumbing. */
function toListItem(row: InboxSelect): InboxListItem {
  const params = row.params as TitleParams;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    subtitle: row.subtitle,
    deepLink: row.deepLink,
    dueAt: row.dueAt,
    seenAt: row.seenAt,
    doneAt: row.doneAt,
    closedReason: row.closedReason as ClosedReason | null,
    // UC-INB-001 puts the original approver in `params` and §7 surfaces the name
    // as `delegateOf`. Snapshotted at creation like the title (BR-INB-005), so a
    // later name change does not rewrite a task somebody already acted on.
    delegateOf: typeof params.delegateOfName === 'string' ? params.delegateOfName : null,
    createdAt: row.createdAt,
  };
}
