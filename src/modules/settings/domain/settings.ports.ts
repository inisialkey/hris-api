import type { CancelPlan, WritePlan } from './plan-write';
import type { SettingLevel, SettingScope, SettingValueRow } from './setting.types';

export const SETTING_VALUE_REPOSITORY = Symbol('SETTING_VALUE_REPOSITORY');

/** The exact scope a value row is written at — `undefined` fields mean tenant level. */
export interface ExactScope {
  level: SettingLevel;
  companyId?: string;
  branchId?: string;
}

export interface SettingValueRepositoryPort {
  /**
   * Every row of every key for the caller's scope chain that is live at `asOf`.
   * One query feeds the whole resolved map — the cache stores maps, not keys
   * (§4.1), so resolving one key and resolving all of them cost the same.
   */
  listLiveForScope(scope: SettingScope, asOf: string): Promise<SettingValueRow[]>;
  /** Every row for one key at the chain, any date — the as-of-past path. */
  listForKey(key: string, scope: SettingScope): Promise<SettingValueRow[]>;
  /** Every row for one key at one exact scope — what write planning reasons over. */
  listForKeyAtScope(key: string, scope: ExactScope): Promise<SettingValueRow[]>;
  findById(id: string): Promise<SettingValueRow | null>;
  /** History for the editor, newest first (§7). */
  listHistory(
    key: string,
    scope: ExactScope,
    page: { limit: number; offset: number },
  ): Promise<{ rows: SettingValueHistoryRow[]; total: number }>;
  /** Close, drop and insert in the caller's transaction — never three calls. */
  applyWrite(key: string, scope: ExactScope, plan: WritePlan): Promise<SettingValueRow>;
  applyCancel(plan: CancelPlan): Promise<void>;
}

export interface SettingValueHistoryRow extends SettingValueRow {
  createdBy: string | null;
  createdAt: Date;
}

export const SETTINGS_CACHE = Symbol('SETTINGS_CACHE');

/**
 * BR-SET-009's resolution cache. Keyed by scope because that is what a resolved
 * map is a function of; busted on write, with a TTL backstop so a lost bust
 * (Redis blip, §9) expires rather than persists.
 */
export interface SettingsCachePort {
  read(tenantId: string, scope: SettingScope): Promise<Record<string, unknown> | null>;
  write(tenantId: string, scope: SettingScope, values: Record<string, unknown>): Promise<void>;
  /** Every scope under the tenant — a tenant-level write changes company reads. */
  bust(tenantId: string): Promise<void>;
}

export const SETTINGS_OUTBOX = Symbol('SETTINGS_OUTBOX');

export interface SettingsOutboxPort {
  emit(event: {
    name: 'settings.value.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export const SETTINGS_PORT = Symbol('SETTINGS_PORT');

/**
 * UC-SET-001 — the one call other modules make.
 *
 * `asOf` is not optional-by-convenience: BR-SET-004 says a consumer computing
 * against a period reads as-of that period's date, and a consumer on the request
 * path reads as-of now. Omitting it means the second, and payroll omitting it
 * would be the determinism bug ADR-0012 exists to prevent.
 *
 * An unknown key throws rather than failing — a key that is not in the registry
 * is a typo in the caller, not a condition a user can be told about.
 */
export interface SettingsPort {
  resolve<T>(key: string, scope?: SettingScope, asOf?: string): Promise<T>;
}
