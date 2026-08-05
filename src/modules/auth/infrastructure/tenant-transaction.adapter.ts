import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import { ConnectionProvider } from '../../../database/connection.provider';
import { tenants } from '../../../database/schema';
import { UnitOfWork } from '../../../database/unit-of-work';
import type {
  TenantStatusPort,
  TenantTransactionPort,
} from '../application/ports/auth-services.port';

/** Platform-internal constant, deliberately not tenant-tunable (multi-tenancy §2). */
const STATUS_TTL_SECONDS = 30;

/**
 * The two pieces of database and cache machinery the auth module's use cases and
 * guards need, behind their ports so that neither `application/` nor
 * `presentation/` imports `src/database` or ioredis directly.
 */
@Injectable()
export class TenantTransactionAdapter implements TenantTransactionPort {
  constructor(private readonly uow: UnitOfWork) {}

  async runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.uow.run({ tenantId, source: 'jwt' }, fn);
  }
}

@Injectable()
export class TenantStatusAdapter implements TenantStatusPort {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly connection: ConnectionProvider,
    private readonly uow: UnitOfWork,
  ) {}

  async status(tenantId: string): Promise<string> {
    const key = `hris:tenant:${tenantId}:status`;
    const cached = await this.redis.get(key);
    if (cached !== null) return cached;

    // `tenants` is a platform table with no RLS, so this read needs no tenant
    // context — which is what lets the status check run at guard position 4,
    // three ahead of the transaction that would otherwise have to exist first.
    const status = await this.uow.runWithoutTenant(async () => {
      const rows = await this.connection
        .handle()
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      return rows[0]?.status ?? 'missing';
    });

    await this.redis.set(key, status, 'EX', STATUS_TTL_SECONDS);
    return status;
  }
}
