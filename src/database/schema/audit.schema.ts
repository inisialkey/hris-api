// Audit schema — audit-log.md §4.1, applied verbatim.
//
// Two tables, both append-only in the structural sense: BR-AUD-001 revokes
// UPDATE and DELETE from `hris_app` in the migration, so "corrections are new
// rows" is enforced by the grant rather than by review. RLS is not expressed
// here — Drizzle cannot emit a policy (database-conventions §10 rule 4).

import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { id, tenantId } from './_shared';

export const auditActorType = pgEnum('audit_actor_type', ['user', 'system', 'platform_op']);

export const auditLogs = pgTable(
  'audit_logs',
  {
    ...id, // uuidv7 id doubles as time-order tiebreaker — and as the insert-time
    ...tenantId, //  range the daily anchor is computed over (UC-AUD-005)
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: auditActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id'), // NULL for pure system rows
    impersonatorId: uuid('impersonator_id'), // BR-AUD-008
    requestId: text('request_id'),
    action: text('action').notNull(), // '<table>.updated' | event name | sensitive-read key
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    diff: jsonb('diff'), // { changed: { col: { before, after } | { masked: true } } }
    metadata: jsonb('metadata'), // ip/userAgent for security facts; job ids for system rows
    eventId: uuid('event_id'), // channel-2 dedup; no FK (erd-overview §7)
  },
  (t) => [
    uniqueIndex('uq_audit_logs_event')
      .on(t.eventId)
      .where(sql`event_id IS NOT NULL`),
    index('idx_audit_logs_cursor').on(t.tenantId, t.occurredAt, t.id), // keyset feed
    index('idx_audit_logs_entity').on(t.tenantId, t.entityType, t.entityId, t.occurredAt),
    index('idx_audit_logs_actor').on(t.tenantId, t.actorUserId, t.occurredAt),
  ],
);

export const auditAnchors = pgTable(
  'audit_anchors',
  {
    // BR-AUD-009
    ...id,
    ...tenantId,
    day: date('day').notNull(),
    rowCount: integer('row_count').notNull(),
    digest: text('digest').notNull(), // sha256(ordered row hashes + prev_digest)
    prevDigest: text('prev_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_audit_anchors_day').on(t.tenantId, t.day)],
);
