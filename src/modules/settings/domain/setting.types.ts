/**
 * The vocabulary of settings.md §4.1, expressed once.
 *
 * A setting value is one scalar per key, scope and date — that sentence is the
 * whole model, and §4.2 leans on it to explain why a TER table is a platform
 * table and not a key.
 */

export type SettingLevel = 'tenant' | 'company' | 'branch';

export type SettingType = 'boolean' | 'integer' | 'decimal' | 'string' | 'enum' | 'json';

/** BR-SET-008: `loosen_only` is declared and unused in V1, per the rule's own note. */
export type SettingDirection = 'tighten_only' | 'loosen_only';

export interface SettingValidation {
  min?: number;
  max?: number;
  enum?: string[];
  pattern?: string;
  direction?: SettingDirection;
}

export interface SettingDefinition {
  key: string;
  module: string;
  type: SettingType;
  allowedLevels: SettingLevel[];
  defaultValue: unknown;
  validation?: SettingValidation;
  effectiveDated: boolean;
  clientVisible: boolean;
  /** Overrides `settings.setting.configure` for a high-stakes key (§2). */
  requiredPermission?: string;
  description: string;
}

/** The place a value is written to, and the chain a read walks up. */
export interface SettingScope {
  companyId?: string;
  branchId?: string;
}

export interface SettingValueRow {
  id: string;
  key: string;
  level: SettingLevel;
  companyId: string | null;
  branchId: string | null;
  value: unknown;
  /** `YYYY-MM-DD`; the interval is `[effectiveFrom, effectiveTo)`. */
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Which level supplied a resolved value — the editor renders it (§6). */
export type SettingOrigin = SettingLevel | 'default';
