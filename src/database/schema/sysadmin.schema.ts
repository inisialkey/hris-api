// system-administration.md §4.1 — platform-class tables (no `tenant_id` under
// RLS, no policy, no tenant write path).
//
// Only `tenant_keys` is here, and it arrives ahead of its owning module for the
// reason `TenantScopedRepository` arrived ahead of audit-log's channel 2: the
// employee module is the first code in the system that encrypts a column, and
// ADR-0016 puts the wrapped DEK in this table. system-administration.md owns it
// and will be its only **writer** (BR-ADM-005, provisioning); the `shared/`
// crypto helper is and stays its only **reader**. Until provisioning ships,
// `seed-dev` and the integration harness mint the row — which is the same
// arrangement as every other table whose writer is a module further down the
// spine. Recorded as A-195.

import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { auditColumns, id } from './_shared';
import { tenants } from './core.schema';

export const tenantKeys = pgTable(
  'tenant_keys',
  {
    ...id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    wrappedDek: text('wrapped_dek').notNull(), // KMS-wrapped; plaintext never persisted
    wrappedIndexKey: text('wrapped_index_key').notNull(), // HMAC key for nik_bidx / npwp_bidx
    kekVersion: text('kek_version').notNull(), // re-wrap target on KEK rotation
    dekVersion: integer('dek_version').notNull().default(1), // matches the 'v1:' ciphertext prefix
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex('uq_tenant_keys_tenant_id').on(t.tenantId)],
);
