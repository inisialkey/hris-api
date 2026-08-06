import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type { PlacementCachePort } from '../domain/organization.ports';
import type { Placement } from '../domain/organization.types';

/**
 * §4.2's placement cache: `hris:organization:{tenantId}:placement:{employeeId}`
 * (naming §8), TTL five minutes, busted on `organization.assignment.changed`.
 *
 * Attendance derivation hits this per punch, which is what makes it worth having
 * at all — the same settings reasoning applies to the failure modes: **the TTL is
 * a backstop, not the mechanism.** A bust lost to a Redis blip expires rather
 * than persisting, so a failed bust is logged and never raised. Raising it would
 * roll the caller's transaction back, and a Redis outage would then stop every
 * employee move in the system to avoid five minutes of staleness §14 already
 * bounds by exactly that window.
 */
const TTL_SECONDS = 5 * 60;

@Injectable()
export class PlacementCache implements PlacementCachePort {
  private readonly logger = new Logger(PlacementCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(tenantId: string, employeeId: string): Promise<Placement | null> {
    try {
      const cached = await this.redis.get(key(tenantId, employeeId));
      return cached ? (JSON.parse(cached) as Placement) : null;
    } catch (error) {
      this.logger.warn(
        `placement cache read failed, resolving from the database: ${String(error)}`,
      );
      return null;
    }
  }

  async write(tenantId: string, employeeId: string, placement: Placement): Promise<void> {
    try {
      await this.redis.set(key(tenantId, employeeId), JSON.stringify(placement), 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`placement cache write failed: ${String(error)}`);
    }
  }

  async bust(tenantId: string, employeeId: string): Promise<void> {
    try {
      await this.redis.del(key(tenantId, employeeId));
    } catch (error) {
      this.logger.warn(`placement cache bust failed, the TTL will expire it: ${String(error)}`);
    }
  }
}

function key(tenantId: string, employeeId: string): string {
  return `hris:organization:${tenantId}:placement:${employeeId}`;
}
