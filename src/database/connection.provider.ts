import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;
/** Drizzle types a transaction as the same surface minus `transaction()`. */
export type DatabaseHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** Holds the open transaction for the duration of one unit-of-work. */
export const transactionStore = new AsyncLocalStorage<DatabaseHandle>();

/**
 * The ADR-0002 seam for future per-tenant databases (multi-tenancy §7).
 *
 * V1 ignores the tenant and returns the shared pool. The point of the indirection
 * is that moving a tenant out later teaches *this* class a catalog lookup and
 * changes no repository, no use case, and no policy.
 *
 * Outside a unit-of-work it returns the pool handle, where RLS yields zero rows
 * because `app.tenant_id` is unset. That is fail-closed and deliberate: a query
 * that escapes the transaction reads nothing rather than everything.
 */
@Injectable()
export class ConnectionProvider {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  handle(): DatabaseHandle {
    return transactionStore.getStore() ?? this.db;
  }

  /** True only inside a unit-of-work. Used by guards that must fail loudly. */
  inUnitOfWork(): boolean {
    return transactionStore.getStore() !== undefined;
  }
}
