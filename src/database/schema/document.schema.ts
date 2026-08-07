// document-storage.md §4.1, applied verbatim — one table for every stored file.
//
// **Absent from audit-log §4.2 on purpose.** `files` is not channel-1 audited,
// so `FileRepository` does not extend `TenantScopedRepository`: the trail this
// table owes is `document.file.committed` and `document.file.deleted`, which
// audit-log §12 already lists among the events it consumes. A channel-1 diff
// would file a second copy of the same two facts and add a row for every
// `expiry_reminded_at` stamp the scan writes.
//
// RLS and the deferred FK from `employee_contracts` ride the generating
// migration (database-conventions §10 rule 4).

import { sql } from 'drizzle-orm';
import { date, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { auditColumns, id, softDeleteColumns, tenantId } from './_shared';
import { users } from './core.schema';

/** `quarantined` is reserved — ADR-0009 ships V1 without inline AV, hook only. */
export const fileStatus = pgEnum('file_status', ['staged', 'committed', 'quarantined']);

export const files = pgTable(
  'files',
  {
    ...id,
    ...tenantId,
    module: text('module').notNull(), // owning ns (naming §4)
    entityType: text('entity_type').notNull(), // polymorphic owner
    entityId: uuid('entity_id').notNull(),
    category: text('category').notNull(), // registry key (§4.2)
    originalName: text('original_name').notNull(), // sanitized at slot creation
    storagePath: text('storage_path').notNull(), // generated, final after commit
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256'), // set at commit
    status: fileStatus('status').notNull().default('staged'),
    commitFailureCode: text('commit_failure_code'), // last BR-DOC-004 failure, staged rows only
    documentExpiresAt: date('document_expires_at'), // business validity (BR-DOC-008)
    expiryRemindedAt: timestamp('expiry_reminded_at', { withTimezone: true }),
    uploadedBy: uuid('uploaded_by').references(() => users.id), // NULL = worker-generated
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    index('idx_files_entity')
      .on(t.tenantId, t.entityType, t.entityId)
      .where(sql`deleted_at IS NULL`),
    index('idx_files_expiry_scan')
      .on(t.tenantId, t.documentExpiresAt)
      .where(sql`status = 'committed' AND document_expires_at IS NOT NULL AND deleted_at IS NULL`),
    index('idx_files_staged_sweep')
      .on(t.tenantId, t.createdAt)
      .where(sql`status = 'staged'`),
  ],
);
