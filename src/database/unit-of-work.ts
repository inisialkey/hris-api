import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { TenantContext } from '../shared/context';
import { DRIZZLE, type Database, transactionStore } from './connection.provider';

/**
 * Every request and every worker unit-of-work is a tenant-scoped transaction
 * (ADR-0002, backend-nestjs §8.1). Business code never calls this — the HTTP
 * `TransactionInterceptor` and the job wrapper are its only two callers.
 */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async run<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // First statement in the transaction, always. `set_config(..., true)` is
      // transaction-local, which is what makes this compatible with a
      // transaction-mode pooler — a session-level SET would leak across pooled
      // transactions and hand one tenant another tenant's context.
      //
      // `SET LOCAL` cannot take a bind parameter; `set_config` can. That is not
      // style, it is the difference between a parameter and string interpolation
      // into SQL (database-conventions §9.1).
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`);
      return transactionStore.run(tx, fn);
    });
  }

  /**
   * A transaction with **no** tenant variable set.
   *
   * The only sanctioned caller is the pre-tenant auth lookup path, which runs
   * under `SET LOCAL ROLE hris_auth` and reads exactly four tables
   * (authentication.md §4). Anything else opening one reads zero rows from every
   * tenant-class table, which is correct and useless.
   */
  async runWithoutTenant<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => transactionStore.run(tx, fn));
  }
}
