import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * The Redis client, as a peer of `src/database/` rather than a member of it.
 *
 * backend-nestjs §2's tree names `src/database/` because drizzle-kit needs one
 * schema root; it does not enumerate every infrastructure root, and Redis is the
 * same class of thing with none of the same constraints. Keeping it out of
 * `DatabaseModule` also keeps "the database is the only system of record"
 * (database-conventions §1.1) legible in the folder names.
 *
 * Key grammar is naming §8 — `hris:<ns>:{tenantId}:…`, with `-` for
 * platform-level keys, and a TTL on everything except documented durable
 * structures. Those are asserted at the call sites, not here.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 3,
          // Every outbound call carries an explicit timeout
          // (coding-standards-nestjs §4) — no library-default infinite waits.
          commandTimeout: 2_000,
        }),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
