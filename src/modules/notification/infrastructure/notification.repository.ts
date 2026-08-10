import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { notificationDeliveries, notifications } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { NewNotification, NotificationRepositoryPort } from '../domain/notification.ports';
import type {
  FeedCursor,
  FeedItem,
  NotificationRow,
  TemplateParams,
} from '../domain/notification.types';

type NotificationSelect = typeof notifications.$inferSelect;

/**
 * **Not on `TenantScopedRepository`** — `notifications` has no audit-log §4.2
 * entry, so the base's constructor assertion would fail at module init, and it
 * should: a notification is a derived fact whose cause was audited where it
 * happened. Nothing here is an administrative act on someone else's data.
 *
 * No tenant predicate on reads: RLS supplies it (ADR-0002). Writes state the
 * tenant so the policy's `WITH CHECK` re-verifies it.
 */
@Injectable()
export class NotificationRepository implements NotificationRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  /**
   * BR-NTF-004, enforced by `uq_notifications_dedupe` rather than by a read.
   * `ON CONFLICT DO NOTHING` returns no row when the pair already exists, which
   * makes a redelivered handler job a no-op with no race window — the check and
   * the write are one statement.
   */
  async insertIfNew(notification: NewNotification): Promise<NotificationRow | null> {
    const inserted = await this.db
      .insert(notifications)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        userId: notification.userId,
        templateKey: notification.templateKey,
        dedupeKey: notification.dedupeKey,
        title: notification.title,
        body: notification.body,
        params: notification.params,
        deepLink: notification.deepLink,
      })
      .onConflictDoNothing({
        target: [notifications.tenantId, notifications.dedupeKey, notifications.userId],
      })
      .returning();

    return inserted[0] ? toRow(inserted[0]) : null;
  }

  async findById(id: string): Promise<NotificationRow | null> {
    const rows = await this.db.select().from(notifications).where(eq(notifications.id, id));
    return rows[0] ? toRow(rows[0]) : null;
  }

  async feed(
    userId: string,
    page: { limit: number; after?: FeedCursor; unreadOnly: boolean },
  ): Promise<{ rows: FeedItem[]; hasMore: boolean }> {
    const conditions = [eq(notifications.userId, userId), hasLiveInAppDelivery()];
    if (page.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (page.after) {
      // Row-value comparison rather than `created_at < x OR (created_at = x AND
      // id < y)`: one expression the planner drives straight off
      // `idx_notifications_feed` backwards, and one that cannot be written with
      // the halves out of step.
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${page.after.createdAt.toISOString()}::timestamptz, ${page.after.id}::uuid)`,
      );
    }

    // One row past the page: the only way to answer `hasMore` without the count
    // ADR-0007 forbids on a cursor feed.
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(page.limit + 1);

    return { rows: rows.slice(0, page.limit).map(toFeedItem), hasMore: rows.length > page.limit };
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(eq(notifications.userId, userId), hasLiveInAppDelivery(), isNull(notifications.readAt)),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * The `read_at IS NULL` predicate is what makes a second call a no-op rather
   * than a re-stamp: UC-NTF-004 calls mark-read idempotent, and an idempotent
   * mark-read must not move the timestamp it already set.
   */
  async markRead(userId: string, id: string, now: Date): Promise<{ readAt: Date } | null> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ readAt: notifications.readAt });

    const stamped = updated[0]?.readAt;
    if (stamped) return { readAt: stamped };

    // Already read, or not this user's row. The caller cannot tell the two apart
    // from here and must not — one is a success and the other is a 404.
    const existing = await this.db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));

    const already = existing[0]?.readAt;
    return already ? { readAt: already } : null;
  }

  async markAllRead(userId: string, now: Date): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  }

  /**
   * BR-NTF-010 — *"unread does not exempt a row"*, so there is no `read_at`
   * predicate here. Delivery rows follow through `ON DELETE CASCADE`;
   * `notification_preferences` is a different table and is untouched.
   */
  async deleteCreatedBefore(cutoff: Date, limit: number): Promise<number> {
    const doomed = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(lt(notifications.createdAt, cutoff))
      .limit(limit);

    if (doomed.length === 0) return 0;

    // The count comes from the `DELETE`, not from the `SELECT` that chose the
    // batch: a concurrent run of the same job would otherwise have both report
    // rows only one of them removed, and a purge that overstates what it deleted
    // is the one number nobody can check afterwards.
    const removed = await this.db
      .delete(notifications)
      .where(
        inArray(
          notifications.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: notifications.id });
    return removed.length;
  }
}

/**
 * The feed's population predicate. A semi-join rather than a join: the delivery
 * row decides membership and contributes no columns, and `EXISTS` stops at the
 * first match on `uq_notification_deliveries_channel`.
 *
 * `status <> 'skipped'` is what makes an opt-out disappear from the feed rather
 * than sit in it greyed out — §4.1 records the suppression as a delivery state,
 * and BR-NTF-005 says the user asked not to be told.
 */
function hasLiveInAppDelivery(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${notificationDeliveries} d
    WHERE d.notification_id = ${notifications.id}
      AND d.channel = 'in_app'
      AND d.status <> 'skipped'
  )`;
}

function toRow(row: NotificationSelect): NotificationRow {
  return {
    id: row.id,
    userId: row.userId,
    templateKey: row.templateKey,
    dedupeKey: row.dedupeKey,
    title: row.title,
    body: row.body,
    params: row.params as TemplateParams,
    deepLink: row.deepLink,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/** §7's feed shape — no `dedupeKey`, no `params`; both are plumbing. */
function toFeedItem(row: NotificationSelect): FeedItem {
  return {
    id: row.id,
    templateKey: row.templateKey,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
