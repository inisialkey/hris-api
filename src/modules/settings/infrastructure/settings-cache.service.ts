import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import type { SettingScope } from '../domain/setting.types';
import type { SettingsCachePort } from '../domain/settings.ports';

/**
 * BR-SET-009's resolution cache: `hris:settings:{tenantId}:{companyId|-}:{branchId|-}`
 * (naming §8) holding the whole resolved as-of-now map for that scope.
 *
 * **The TTL is a backstop, not the mechanism.** Writes bust; the five minutes
 * exist so that a bust lost to a Redis blip expires rather than persists — §9
 * names exactly that case and answers it with the TTL, which is why a failed
 * bust is logged and not raised. Raising it would roll the caller's transaction
 * back, so a Redis outage would stop every settings write in the system to avoid
 * five minutes of staleness the rule already accepts.
 */
const TTL_SECONDS = 5 * 60;

@Injectable()
export class SettingsCache implements SettingsCachePort {
  private readonly logger = new Logger(SettingsCache.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(tenantId: string, scope: SettingScope): Promise<Record<string, unknown> | null> {
    try {
      const cached = await this.redis.get(key(tenantId, scope));
      return cached ? (JSON.parse(cached) as Record<string, unknown>) : null;
    } catch (error) {
      this.logger.warn(`settings cache read failed, resolving from the database: ${String(error)}`);
      return null;
    }
  }

  async write(
    tenantId: string,
    scope: SettingScope,
    values: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.redis.set(key(tenantId, scope), JSON.stringify(values), 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`settings cache write failed: ${String(error)}`);
    }
  }

  /**
   * The whole tenant, not the written scope: a tenant-level write changes what
   * every company and branch under it resolves to, and busting only the scope
   * that was edited would leave the inheriting scopes serving the old value —
   * which is the inheritance bug that is hardest to reproduce.
   */
  async bust(tenantId: string): Promise<void> {
    // ponytail: SCAN over the tenant's prefix. Correct at any tenant size and
    // non-blocking, unlike KEYS. If a tenant ever holds enough scopes for this
    // to matter, the upgrade is a per-tenant generation counter in the key.
    const pattern = `hris:settings:${tenantId}:*`;
    try {
      let cursor = '0';
      do {
        const [next, found] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = next;
        if (found.length > 0) await this.redis.del(...found);
      } while (cursor !== '0');
    } catch (error) {
      this.logger.error(`settings cache bust failed, falling back to the TTL: ${String(error)}`);
    }
  }
}

function key(tenantId: string, scope: SettingScope): string {
  return `hris:settings:${tenantId}:${scope.companyId ?? '-'}:${scope.branchId ?? '-'}`;
}
