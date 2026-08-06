// Settings schema — settings.md §4.1, applied verbatim.
//
// Two tables on opposite sides of the tenancy line: definitions are platform
// data seeded from code (BR-SET-001 — tenants set values, never keys), values
// are tenant-owned and RLS'd. The CHECK and the exclusion constraint that make
// §4.1's scope and interval rules true live in the migration; Drizzle can
// express neither (database-conventions §5.2, §10 rule 4).

import {
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, id, tenantId } from './_shared';
import { companies } from './core.schema';

export const settingLevel = pgEnum('setting_level', ['tenant', 'company', 'branch']);
export const settingType = pgEnum('setting_type', [
  'boolean',
  'integer',
  'decimal',
  'string',
  'enum',
  'json',
]);

export const settingDefinitions = pgTable(
  'setting_definitions',
  {
    // platform table — no tenant_id, seeded from code
    ...id,
    key: text('key').notNull(), // naming §9: <ns>.<setting_snake_case>, units in leaf
    module: text('module').notNull(), // ns from naming §4
    type: settingType('type').notNull(),
    allowedLevels: settingLevel('allowed_levels').array().notNull(),
    defaultValue: jsonb('default_value').notNull(), // the platform level of the hierarchy
    validation: jsonb('validation'), // { min?, max?, enum?, pattern?, direction? }
    effectiveDated: boolean('effective_dated').notNull().default(false),
    clientVisible: boolean('client_visible').notNull().default(false),
    requiredPermission: text('required_permission'), // overrides settings.setting.configure (§2)
    description: text('description').notNull(),
    deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex('uq_setting_definitions_key').on(t.key)],
);

export const settingValues = pgTable(
  'setting_values',
  {
    // tenant-owned, RLS
    ...id,
    ...tenantId,
    key: text('key').notNull(),
    level: settingLevel('level').notNull(),
    companyId: uuid('company_id').references(() => companies.id), // level ≥ company
    // No `.references(() => branches)`: the organization module owns that table
    // and has not been built. The column and the scope CHECK are here because
    // §4.1 declares them; the foreign key is one line in the migration that
    // creates `branches`, which is where it belongs anyway.
    branchId: uuid('branch_id'), // level = branch
    value: jsonb('value').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'), // NULL = current
    ...auditColumns,
  },
  (t) => [index('idx_setting_values_resolve').on(t.tenantId, t.key, t.level, t.effectiveFrom)],
);
