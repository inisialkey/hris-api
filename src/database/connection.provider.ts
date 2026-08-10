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

  /**
   * A nested transaction — a PostgreSQL `SAVEPOINT` when one is already open.
   *
   * The single caller is import-export's commit loop, and the reason is
   * BR-IMP-003: partial mode says *"a bad row is skipped inside its batch, never
   * a batch rollback"*, and a failed statement in PostgreSQL aborts its whole
   * transaction unless a savepoint is standing. Without this, one row hitting a
   * constraint would take every row after it — which is precisely the
   * all-or-nothing behaviour partial mode exists to refuse. Strict mode uses the
   * same primitive from the other end: one savepoint around the whole loop, so
   * *"nothing written"* can be true while the job row still records why.
   *
   * It sits here rather than in the module because reaching a transaction handle
   * is `src/database`'s job (backend-nestjs §8.1) — business code neither opens
   * units of work nor names Drizzle's transaction type.
   */
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const handle = this.handle();
    return handle.transaction(async (nested) => transactionStore.run(nested, fn));
  }
}
