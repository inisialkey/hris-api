import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type { ScheduleCachePort } from '../domain/shift.ports';
import type { ScheduledDay } from '../domain/shift.types';

/**
 * §4.2's verdict cache — `hris:shift:{tenantId}:schedule:{employeeId}:{yyyy-mm}`
 * (naming §8), TTL 15 minutes, **month buckets** because attendance derivation
 * walks a period rather than a date.
 *
 * Busting an employee is a `SCAN` over their own key prefix rather than a stored
 * index: the alternative is a set per employee that has to be kept correct
 * forever to save a scan over twelve keys.
 *
 * `bustTenant` is the coarse one, and it is what `shift.definition.changed`
 * deserves — §12 makes that event deliberately coarse because the affected
 * employee set is unbounded.
 *
 * Fail-soft throughout, on the placement-cache precedent: a lost bust expires
 * within the TTL, while raising would roll back the roster edit that caused it.
 */
const TTL_SECONDS = 15 * 60;
const SCAN_COUNT = 200;

@Injectable()
export class ScheduleCache implements ScheduleCachePort {
  private readonly logger = new Logger(ScheduleCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(tenantId: string, employeeId: string, month: string): Promise<ScheduledDay[] | null> {
    try {
      const cached = await this.redis.get(key(tenantId, employeeId, month));
      return cached ? (JSON.parse(cached) as ScheduledDay[]) : null;
    } catch (error) {
      this.logger.warn(`schedule cache read failed, resolving from the database: ${String(error)}`);
      return null;
    }
  }

  async write(
    tenantId: string,
    employeeId: string,
    month: string,
    days: readonly ScheduledDay[],
  ): Promise<void> {
    try {
      await this.redis.set(
        key(tenantId, employeeId, month),
        JSON.stringify(days),
        'EX',
        TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`schedule cache write failed: ${String(error)}`);
    }
  }

  async bustEmployee(tenantId: string, employeeId: string): Promise<void> {
    await this.deleteMatching(`hris:shift:${tenantId}:schedule:${employeeId}:*`);
  }

  async bustEmployees(tenantId: string, employeeIds: readonly string[]): Promise<void> {
    for (const employeeId of employeeIds) await this.bustEmployee(tenantId, employeeId);
  }

  async bustTenant(tenantId: string): Promise<void> {
    await this.deleteMatching(`hris:shift:${tenantId}:schedule:*`);
  }

  private async deleteMatching(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      this.logger.warn(`schedule cache bust failed, the TTL will expire it: ${String(error)}`);
    }
  }
}

function key(tenantId: string, employeeId: string, month: string): string {
  return `hris:shift:${tenantId}:schedule:${employeeId}:${month}`;
}
