// import-export.md §4.1, applied verbatim — two job tables and nothing else.
//
// **Neither is in audit-log §4.2**, so neither repository extends
// `TenantScopedRepository`. A job row is a record of machinery: what the trail
// wants is the *writes the commit made*, and those are audited inside the
// modules whose `rowHandler` made them, on their own tables. §12's two events
// are already on audit-log's consumed list (channel 2), which is where "an
// import was committed" is filed once rather than twice.
//
// Both tables carry `...auditColumns` because §4.1 says so and because
// `created_by` is load-bearing here rather than decorative: BR-IMP-010 makes it
// the **only** identity that may download an export output.
//
// RLS and the two partial indexes ride the generating migration
// (database-conventions §10 rule 4).

import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { auditColumns, id, tenantId } from './_shared';
import { users } from './core.schema';
import { files } from './document.schema';

export const importJobStatus = pgEnum('import_job_status', [
  'uploaded',
  'validating',
  'awaiting_confirmation',
  'committing',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
]);

export const exportJobStatus = pgEnum('export_job_status', [
  'queued',
  'running',
  'completed',
  'failed',
]);

export const importJobs = pgTable(
  'import_jobs',
  {
    ...id,
    ...tenantId,
    type: text('type').notNull(), // definition key (§4.3)
    status: importJobStatus('status').notNull().default('uploaded'),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id), // uploaded xlsx (document-storage)
    errorReportFileId: uuid('error_report_file_id').references(() => files.id),
    templateVersion: integer('template_version'), // read from _meta at parse
    totalRows: integer('total_rows'),
    validRows: integer('valid_rows'),
    errorRows: integer('error_rows'),
    appliedRows: integer('applied_rows'),
    lastCommittedBatch: integer('last_committed_batch'), // BR-IMP-004 resume cursor
    failureCode: text('failure_code'), // job-level IMP_ code when failed
    confirmedBy: uuid('confirmed_by').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditColumns, // created_by = requester
  },
  (t) => [
    // BR-IMP-005's concurrency guard. A *partial* unique index rather than a
    // constraint, because the rule bounds only the four live statuses — a tenant
    // may hold any number of finished imports of one type, and only PostgreSQL's
    // partial index can say that. drizzle-kit cannot emit `uniqueIndex().where()`
    // as a table constraint, so it rides the migration as `-- manual:` SQL
    // alongside RLS (A-200).
    index('idx_import_jobs_list').on(t.tenantId, t.createdAt),
  ],
);

export const exportJobs = pgTable(
  'export_jobs',
  {
    ...id,
    ...tenantId,
    type: text('type').notNull(),
    status: exportJobStatus('status').notNull().default('queued'),
    // Definition-declared filter shape, plus the column entitlement UC-IMP-006
    // freezes at enqueue (§4.3's `_columns`, BR-IMP-010).
    params: jsonb('params').notNull(),
    fileId: uuid('file_id').references(() => files.id), // result (import_file category, ADR-0009)
    rowCount: integer('row_count'),
    failureCode: text('failure_code'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index('idx_export_jobs_list').on(t.tenantId, t.createdAt)],
);

/**
 * The four statuses BR-IMP-005 calls active, in one place because the partial
 * unique index in the migration and the guard in the repository must agree —
 * two lists that drift are a race nobody sees until two imports commit.
 */
export const ACTIVE_IMPORT_STATUSES = [
  'uploaded',
  'validating',
  'awaiting_confirmation',
  'committing',
] as const;
