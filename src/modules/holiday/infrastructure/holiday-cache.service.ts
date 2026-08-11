import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type { HolidayCachePort } from '../domain/holiday.ports';
import type { ResolvableRow } from '../domain/resolve';

/**
 * UC-HOL-001's cache: `hris:holiday:{tenantId}:rows:{yyyy-mm}` (naming §8), one
 * entry per tenant-month holding the rows BR-HOL-002 reduces.
 *
 * Fail-soft, on the placement-cache precedent: a lost bust expires rather than
 * persisting, so a Redis outage costs fifteen minutes of staleness instead of
 * rolling back every calendar edit in the tenant.
 */
const TTL_SECONDS = 15 * 60;

@Injectable()
export class HolidayCache implements HolidayCachePort {
  private readonly logger = new Logger(HolidayCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(tenantId: string, month: string): Promise<ResolvableRow[] | null> {
    try {
      const cached = await this.redis.get(key(tenantId, month));
      return cached ? (JSON.parse(cached) as ResolvableRow[]) : null;
    } catch (error) {
      this.logger.warn(`holiday cache read failed, resolving from the database: ${String(error)}`);
      return null;
    }
  }

  async write(tenantId: string, month: string, rows: readonly ResolvableRow[]): Promise<void> {
    try {
      await this.redis.set(key(tenantId, month), JSON.stringify(rows), 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`holiday cache write failed: ${String(error)}`);
    }
  }

  async bust(tenantId: string, months: readonly string[]): Promise<void> {
    if (months.length === 0) return;
    try {
      await this.redis.del(...months.map((month) => key(tenantId, month)));
    } catch (error) {
      this.logger.warn(`holiday cache bust failed, the TTL will expire it: ${String(error)}`);
    }
  }
}

function key(tenantId: string, month: string): string {
  return `hris:holiday:${tenantId}:rows:${month}`;
}
