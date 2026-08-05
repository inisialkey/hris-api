// authentication.md §4. `users`, `sessions` and `devices` are owned by this
// module too but live in core.schema.ts, because core-schema.md defines them and
// a second definition is a second truth.

import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { auditColumns, id, tenantId } from './_shared';
import { users } from './core.schema';

export const tokenPurpose = pgEnum('token_purpose', ['password_reset', 'invite']);

export const authTokens = pgTable(
  'auth_tokens',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(), // sha256; raw token only in the email link
    purpose: tokenPurpose('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    ...auditColumns, // created_by NULL for self-service requests
  },
  (t) => [
    uniqueIndex('uq_auth_tokens_token_hash').on(t.tokenHash),
    index('idx_auth_tokens_tenant_id_user_id').on(t.tenantId, t.userId),
  ],
);
