import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type {
  RefreshSuccessor,
  RotationGracePort,
  UsedTokenHistoryPort,
} from '../application/ports/auth-services.port';

/**
 * The two Redis structures of authentication.md §4, keyed by refresh-token
 * hash. Both are platform-level (`-` tenant segment, naming §8): a refresh
 * arrives before any tenant is proven, so a tenant-prefixed key could not be
 * looked up yet.
 *
 * The grace cache holds the raw successor pair for 10 seconds — sanctioned by
 * §4, bounded by the TTL, and inside the trust class security-standards §8
 * assigns Redis. The history holds only ids.
 */
const GRACE_TTL_SECONDS = 10;
const HISTORY_TTL_SECONDS = 7 * 24 * 3600;

@Injectable()
export class RotationGraceCache implements RotationGracePort {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(oldTokenHash: string): string {
    return `hris:auth:-:rt-grace:${oldTokenHash}`;
  }

  async remember(oldTokenHash: string, successor: RefreshSuccessor): Promise<void> {
    await this.redis.set(
      this.key(oldTokenHash),
      JSON.stringify(successor),
      'EX',
      GRACE_TTL_SECONDS,
    );
  }

  async lookup(oldTokenHash: string): Promise<RefreshSuccessor | null> {
    const raw = await this.redis.get(this.key(oldTokenHash));
    return raw ? (JSON.parse(raw) as RefreshSuccessor) : null;
  }
}

@Injectable()
export class UsedTokenHistory implements UsedTokenHistoryPort {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(tokenHash: string): string {
    return `hris:auth:-:rt-used:${tokenHash}`;
  }

  async remember(tokenHash: string, ref: { sessionId: string; tenantId: string }): Promise<void> {
    await this.redis.set(this.key(tokenHash), JSON.stringify(ref), 'EX', HISTORY_TTL_SECONDS);
  }

  async lookup(tokenHash: string): Promise<{ sessionId: string; tenantId: string } | null> {
    const raw = await this.redis.get(this.key(tokenHash));
    return raw ? (JSON.parse(raw) as { sessionId: string; tenantId: string }) : null;
  }
}
