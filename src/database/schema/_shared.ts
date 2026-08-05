// Shared column builders — database-conventions §3.4, copied as written.
// Every table spreads these; hand-rolling audit, tenant, soft-delete or
// effective-dating columns is a review blocker, which is only enforceable if
// there is exactly one place they are spelled.
//
// The import of `tenants` below is circular with core.schema.ts and is safe for
// one reason: Drizzle's `references()` takes a callback, so the table is read
// when the FK is resolved rather than when this module initialises.

import { date, integer, timestamp, uuid } from 'drizzle-orm/pg-core';

import { uuidv7 } from 'uuidv7';

import { tenants } from './core.schema';

export const id = {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
};

export const tenantId = {
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
};

export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
};

export const softDeleteColumns = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
};

export const effectiveDating = {
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
};

export const versionColumn = { version: integer('version').notNull().default(1) };
