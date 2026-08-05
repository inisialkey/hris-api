import { index, pgTable, text } from 'drizzle-orm/pg-core';

import { auditColumns, id, tenantId } from './_shared';

/**
 * The throwaway table of the walking skeleton (implementation-roadmap §4.1
 * item 2: *"RLS on one throwaway table"*).
 *
 * **This table and its module are deleted when the platform spine lands.** It is
 * here to be the target of the multi-tenancy §5 leak matrix and of one route
 * through the full guard chain, before any real module exists to be that target.
 * It carries no business meaning, and it deliberately carries no business
 * meaning: a skeleton table that looked useful would acquire a consumer, and
 * then it would not be deleted.
 *
 * It is nonetheless a fully conforming tenant-owned table — audit columns, the
 * tenant FK, the tenant-leading index, and the RLS policy in its own migration.
 * A throwaway that skipped the conventions would prove the conventions work on
 * nothing.
 */
export const scratchNotes = pgTable(
  'scratch_notes',
  {
    ...id,
    ...tenantId,
    body: text('body').notNull(),
    ...auditColumns,
  },
  (t) => [index('idx_scratch_notes_tenant_id').on(t.tenantId)],
);
