import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type { LoginAttemptPort } from '../application/ports/auth-services.port';

/** security-standards §2 defaults. Tenant-tunable via `auth.*` once settings land. */
const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;

/**
 * BR-AUTH-003. The counter is keyed by lowercased email **before** tenant
 * resolution, because at that point in the flow there is no tenant yet — and
 * because a per-tenant counter would let an attacker get five free attempts per
 * tenant against the same credential.
 *
 * Unknown emails produce identical lockout behaviour to known ones. A lockout
 * that only ever fires for real accounts is an enumeration oracle.
 *
 * The email is hashed into the key rather than embedded. Redis keys turn up in
 * `MONITOR` output, in slow-log entries, and in support screenshots; none of
 * those are places an employee's address needs to be.
 */
@Injectable()
export class LoginAttemptService implements LoginAttemptPort {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(email: string): string {
    const digest = createHash('sha256').update(email).digest('hex').slice(0, 32);
    // naming §8: `-` is the tenant segment for platform-level keys.
    return `hris:auth:-:lockout:${digest}`;
  }

  /** `retryAfterSeconds` when locked, `null` when the attempt may proceed. */
  async check(email: string): Promise<number | null> {
    const key = this.key(email);
    const attempts = Number((await this.redis.get(key)) ?? '0');
    if (attempts < MAX_ATTEMPTS) return null;

    const ttl = await this.redis.ttl(key);
    return ttl > 0 ? ttl : LOCK_SECONDS;
  }

  async recordFailure(email: string): Promise<void> {
    const key = this.key(email);
    const attempts = await this.redis.incr(key);
    // Set the window on the first failure and never extend it: refreshing the
    // TTL on every attempt turns a 15-minute lockout into a permanent one for
    // anyone under a sustained attack.
    if (attempts === 1) await this.redis.expire(key, LOCK_SECONDS);
  }

  async recordSuccess(email: string): Promise<void> {
    await this.redis.del(this.key(email));
  }
}
