// inbox.md §4, applied verbatim — one table, the unified task list.
//
// **Absent from audit-log §4.2 on purpose**, so its repository does not extend
// `TenantScopedRepository`. Every row here is materialized by a handler from an
// event whose cause was audited where it happened, and the one act a human
// performs on an item — acknowledging — is a fact announcement.md stamps on its
// own recipient row and audit-log §4.2 records there. A channel-1 diff of a
// navigation layer would file "we showed someone a task" beside every approval
// in the system.
//
// The shape differs from most of the schema and each difference is the
// handbook's: `created_at` and no `updated_at` (an item's mutations are its own
// stamps — `seen_at`, `done_at`, `closed_reason`), no soft delete (BR-INB-010
// purges hard, and an item is not a business entity anyone restores), and no
// `version` (nothing here is a mutable owned record; offline-sync §10 puts
// `inbox_items` in the **reference data** class, which never enters the queue).
//
// RLS, the status invariant CHECK, and the closure index ride the generating
// migration (database-conventions §10 rule 4).

import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { id, tenantId } from './_shared';
import { users } from './core.schema';

export const inboxItemType = pgEnum('inbox_item_type', ['approval_task', 'acknowledgment']);
export const inboxItemStatus = pgEnum('inbox_item_status', ['open', 'done', 'closed']);

export const inboxItems = pgTable(
  'inbox_items',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: inboxItemType('type').notNull(),
    status: inboxItemStatus('status').notNull().default('open'),
    dedupeKey: text('dedupe_key').notNull(), // BR-INB-004
    title: text('title').notNull(), // locale snapshot (BR-INB-005)
    subtitle: text('subtitle'),
    params: jsonb('params').notNull(),
    sourceRef: jsonb('source_ref').notNull(), // approval: { instanceId, stepId, assigneeId, requestType, requestId }
    // ack: { announcementId }
    deepLink: text('deep_link').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }), // BR-INB-009
    seenAt: timestamp('seen_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    closedReason: text('closed_reason'), // superseded | instance_approved | instance_rejected |
    // instance_returned | instance_cancelled | retracted
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_inbox_items_dedupe').on(t.tenantId, t.userId, t.dedupeKey),
    index('idx_inbox_items_list').on(t.tenantId, t.userId, t.status, t.createdAt),
  ],
);
