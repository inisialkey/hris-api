// notification.md §4.1, applied verbatim — the feed row, its per-channel
// delivery records, and the opt-out rows that suppress optional templates.
//
// **Absent from audit-log §4.2 on purpose**, all three, so none of their
// repositories extends `TenantScopedRepository`. A notification is a *derived*
// fact: the act worth auditing already happened somewhere else and was audited
// there, and a channel-1 diff here would file "we told someone about it" beside
// every one of them. The preference rows are the tenant user's own switches over
// their own traffic, not an administrative act on anyone else.
//
// The three tables differ in shape from most of the schema and each difference
// is the handbook's: `notifications` carries `created_at` and no `updated_at`
// (nothing edits a sent notification except `read_at`), `notification_deliveries`
// carries no timestamps at all beyond `sent_at`, and `notification_preferences`
// is a pure junction with a composite primary key and no `id` — which is also
// why database-conventions §3.1's audit columns are absent from it.
//
// RLS rides the generating migration (database-conventions §10 rule 4).

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { id, tenantId } from './_shared';
import { users } from './core.schema';

export const notificationChannel = pgEnum('notification_channel', ['in_app', 'push', 'email']);
export const deliveryStatus = pgEnum('delivery_status', ['pending', 'sent', 'failed', 'skipped']);

export const notifications = pgTable(
  'notifications',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    templateKey: text('template_key').notNull(), // §4.2 registry key
    dedupeKey: text('dedupe_key').notNull(), // eventId or caller key (BR-NTF-004)
    title: text('title').notNull(), // rendered snapshot (BR-NTF-006)
    body: text('body').notNull(),
    params: jsonb('params').notNull(), // variable values (redacted from logs)
    deepLink: text('deep_link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_notifications_dedupe').on(t.tenantId, t.dedupeKey, t.userId),
    index('idx_notifications_feed').on(t.tenantId, t.userId, t.createdAt), // cursor feed
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    ...id,
    ...tenantId,
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_notification_deliveries_channel').on(t.notificationId, t.channel),
    index('idx_notification_deliveries_status').on(t.tenantId, t.status),
  ],
);

/** Opt-out rows only (BR-NTF-005) — an absent row means the channel is on. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    templateKey: text('template_key').notNull(),
    channel: notificationChannel('channel').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.templateKey, t.channel] })],
);
