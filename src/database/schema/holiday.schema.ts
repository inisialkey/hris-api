// Holiday schema — holiday.md §4.1, applied verbatim.
//
// One table, and the only object drizzle-kit cannot express is the scope CHECK
// of BR-HOL-005 (`branch_id` implies `company_id`), hand-written in the
// generating migration per database-conventions §10 rule 4.
//
// The unique index is the interesting one. BR-HOL-003 keys a row on
// `(scope, date, kind)`, and two of the three scope columns are nullable —
// `NULL` never equals `NULL` in a unique index, so the plain form would let a
// tenant-wide row be inserted a hundred times. `COALESCE` to the nil UUID is
// what gives the absent scope a value to collide on.

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, id, softDeleteColumns, tenantId } from './_shared';
import { companies } from './core.schema';
import { branches } from './organization.schema';

export const holidayKind = pgEnum('holiday_kind', ['national', 'cuti_bersama', 'custom']);

export const holidays = pgTable(
  'holidays',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id').references(() => companies.id), // NULL = tenant-wide
    branchId: uuid('branch_id').references(() => branches.id), // NULL = company-wide
    date: date('date').notNull(),
    name: text('name').notNull(),
    kind: holidayKind('kind').notNull(),
    // false = negation: this scope works a day a broader scope does not (BR-HOL-001)
    observed: boolean('observed').notNull().default(true),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_holidays_scope_date_kind')
      .on(
        t.tenantId,
        sql`COALESCE(${t.companyId}, '00000000-0000-0000-0000-000000000000')`,
        sql`COALESCE(${t.branchId}, '00000000-0000-0000-0000-000000000000')`,
        t.date,
        t.kind,
      )
      .where(sql`deleted_at IS NULL`), // BR-HOL-003
    // The resolution read: every row of a tenant on one date, all three scopes at
    // once, because BR-HOL-002 composes them rather than picking one (UC-HOL-001).
    index('idx_holidays_resolve')
      .on(t.tenantId, t.date)
      .where(sql`deleted_at IS NULL`),
    // The admin year grid, which is company-filtered and date-ranged (§7).
    index('idx_holidays_year').on(t.tenantId, t.companyId, t.date),
  ],
);
