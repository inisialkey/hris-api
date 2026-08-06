import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { SETTING_DEFINITIONS, SETTING_DEFINITIONS_BY_KEY } from '../domain/definitions';
import { resolveValue } from '../domain/resolve';
import type { SettingDefinition, SettingScope } from '../domain/setting.types';
import {
  SETTINGS_CACHE,
  SETTING_VALUE_REPOSITORY,
  type SettingValueRepositoryPort,
  type SettingsCachePort,
  type SettingsPort,
} from '../domain/settings.ports';

/**
 * UC-SET-001 — resolution, and the only entry point other modules use.
 *
 * Two paths, and the split is BR-SET-004's:
 *
 * **As-of now** goes through the scope's cached map. A miss resolves *every*
 * definition in one query rather than the one key asked for, because the cache
 * unit is a map (§4.1) and a chain query costs the same either way — so a
 * request that reads five keys pays for one round trip, and BR-SET-009's "a
 * single request resolves against one cache snapshot" holds by construction.
 *
 * **As-of a past date** bypasses the cache entirely. Payroll re-running May must
 * see May's value, and a cache keyed by scope alone cannot express that; these
 * reads are batch and bounded, so a query each is the right price.
 */
@Injectable()
export class SettingsService implements SettingsPort {
  constructor(
    @Inject(SETTING_VALUE_REPOSITORY) private readonly repository: SettingValueRepositoryPort,
    @Inject(SETTINGS_CACHE) private readonly cache: SettingsCachePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve<T>(key: string, scope: SettingScope = {}, asOf?: string): Promise<T> {
    const definition = definitionOrThrow(key);
    const today = this.today();

    if (asOf && asOf !== today) {
      const rows = await this.repository.listForKey(key, scope);
      return resolveValue(definition, rows, scope, asOf).value as T;
    }

    const map = await this.resolveAll(scope);
    // A cached map written before this release does not contain a key this
    // release added, and `map[key]` would hand the caller `undefined` for up to
    // the TTL after every deploy. The default is what an absent value means.
    return (key in map ? map[key] : definition.defaultValue) as T;
  }

  /** The whole resolved map for a scope — what the cache stores and `/effective` filters. */
  async resolveAll(scope: SettingScope): Promise<Record<string, unknown>> {
    const tenant = requireTenantContext();
    const cached = await this.cache.read(tenant.tenantId, scope);
    if (cached) return cached;

    const today = this.today();
    const rows = await this.repository.listLiveForScope(scope, today);

    const map: Record<string, unknown> = {};
    for (const definition of SETTING_DEFINITIONS) {
      const forKey = rows.filter((row) => row.key === definition.key);
      map[definition.key] = resolveValue(definition, forKey, scope, today).value;
    }

    await this.cache.write(tenant.tenantId, scope, map);
    return map;
  }

  /** UC-SET-005: only `clientVisible` keys ever leave the admin surface (BR-SET-007). */
  async resolveClientVisible(scope: SettingScope): Promise<Record<string, unknown>> {
    const map = await this.resolveAll(scope);
    const visible: Record<string, unknown> = {};
    for (const definition of SETTING_DEFINITIONS) {
      // Same staleness case as `resolve`: a key added this release is missing
      // from a map cached by the previous one.
      if (definition.clientVisible) {
        visible[definition.key] =
          definition.key in map ? map[definition.key] : definition.defaultValue;
      }
    }
    return visible;
  }

  /** The instant `/settings/effective` reports, from the injected clock (§6). */
  now(): string {
    return this.clock.now().toISOString();
  }

  /**
   * The tenant's calendar date. §9 accepts the WIB-boundary noise this carries:
   * a value flipped at midnight takes effect on the server date, and the editor
   * says so rather than the resolver pretending otherwise.
   */
  today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

/**
 * BR-SET-001 read side: an unregistered key is a typo in the caller, not a
 * condition a user can be told about — so it throws rather than returning a
 * `Result` nobody would branch on (UC-SET-001).
 */
export function definitionOrThrow(key: string): SettingDefinition {
  const definition = SETTING_DEFINITIONS_BY_KEY.get(key);
  if (!definition) throw new Error(`unknown setting key: ${key}`);
  return definition;
}
