import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { CLOCK, SystemClock } from '../shared/clock.port';
import { ConnectionProvider, DRIZZLE, type Database } from './connection.provider';
import { TransactionInterceptor } from './transaction.interceptor';
import { UnitOfWork } from './unit-of-work';

export const PG_POOL = Symbol('PG_POOL');

/**
 * Pool, UnitOfWork, ConnectionProvider — the three things backend-nestjs §8.1
 * requires, and nothing else. Global because every module's repositories need
 * the provider and none of them should have to import a database module.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          // `hris_app` — never the owner, never BYPASSRLS. The URL says which,
          // and the init script is what makes the distinction real.
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: Number(config.get<string>('DATABASE_POOL_MAX') ?? '10'),
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool),
    },
    { provide: CLOCK, useClass: SystemClock },
    ConnectionProvider,
    UnitOfWork,
    TransactionInterceptor,
  ],
  exports: [DRIZZLE, PG_POOL, CLOCK, ConnectionProvider, UnitOfWork, TransactionInterceptor],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** SIGTERM drains in-flight work, then this releases the sockets (ADR-0010). */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
