// Shift schema — shift.md §4.1, applied verbatim.
//
// Five tables and no `version` column on any of them: every mutation here is
// admin-web and nothing is offline-mutable (database-conventions §1.10 scope,
// holiday's §4.1 precedent). No lifecycle enums either — shifts and patterns are
// present-or-archived reference data, an assignment is a position on the date
// axis, and a roster day is a fact about one date.
//
// Five constraints drizzle-kit cannot express live in the generating migration
// (database-conventions §10 rule 4): the four CHECKs of §4.1 and the gist
// exclusion that makes "one live arrangement per employee, one live default per
// company" a database fact rather than a hope.

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, effectiveDating, id, softDeleteColumns, tenantId } from './_shared';
import { companies, employees } from './core.schema';

export const shifts = pgTable(
  'shifts',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(), // `OFF` reserved (BR-SHF-001)
    name: text('name').notNull(),
    startTime: time('start_time').notNull(), // branch-local wall clock (BR-SHF-008)
    endTime: time('end_time').notNull(), // < start ⇒ crosses midnight
    breakMinutes: integer('break_minutes').notNull().default(0), // unpaid
    breakStartTime: time('break_start_time'), // optional, display only in V1
    lateToleranceMinutes: integer('late_tolerance_minutes').notNull().default(0),
    earlyLeaveToleranceMinutes: integer('early_leave_tolerance_minutes').notNull().default(0),
    punchInBeforeMinutes: integer('punch_in_before_minutes').notNull().default(60),
    punchOutAfterMinutes: integer('punch_out_after_minutes').notNull().default(60),
    color: text('color'), // roster-grid chip token (design-system §2.1)
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_shifts_tenant_id_company_id_code')
      .on(t.tenantId, t.companyId, t.code)
      .where(sql`deleted_at IS NULL`),
    index('idx_shifts_tenant_id_company_id').on(t.tenantId, t.companyId),
  ],
);

export const shiftPatterns = pgTable(
  'shift_patterns',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    cycleLength: integer('cycle_length').notNull(), // days, 1..31 (CHECK)
    observesHolidays: boolean('observes_holidays').notNull().default(true), // BR-SHF-004
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_shift_patterns_tenant_id_company_id_code')
      .on(t.tenantId, t.companyId, t.code)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const shiftPatternDays = pgTable(
  'shift_pattern_days',
  {
    ...id,
    ...tenantId,
    patternId: uuid('pattern_id')
      .notNull()
      .references(() => shiftPatterns.id),
    dayIndex: integer('day_index').notNull(), // 0 .. cycleLength-1, each exactly once
    shiftId: uuid('shift_id').references(() => shifts.id), // NULL = OFF day in the cycle
    ...auditColumns, // replaced wholesale on pattern save (hard delete)
  },
  (t) => [
    uniqueIndex('uq_shift_pattern_days_tenant_id_pattern_id_day_index').on(
      t.tenantId,
      t.patternId,
      t.dayIndex,
    ),
  ],
);

export const rosterAssignments = pgTable(
  'roster_assignments',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    employeeId: uuid('employee_id').references(() => employees.id), // NULL = company default (BR-SHF-002)
    patternId: uuid('pattern_id')
      .notNull()
      .references(() => shiftPatterns.id),
    cycleAnchorDate: date('cycle_anchor_date').notNull(), // phase (BR-SHF-003)
    note: text('note'),
    ...effectiveDating,
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    index('idx_roster_assignments_tenant_id_employee_id_effective_from').on(
      t.tenantId,
      t.employeeId,
      t.effectiveFrom,
    ),
    // default-row lookup + pattern archive guard
    index('idx_roster_assignments_tenant_id_company_id_effective_from').on(
      t.tenantId,
      t.companyId,
      t.effectiveFrom,
    ),
    index('idx_roster_assignments_tenant_id_pattern_id').on(t.tenantId, t.patternId),
  ],
);

export const rosterDays = pgTable(
  'roster_days',
  {
    ...id,
    ...tenantId,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    date: date('date').notNull(),
    shiftId: uuid('shift_id').references(() => shifts.id), // NULL = explicit day off
    worksOnHoliday: boolean('works_on_holiday').notNull().default(false), // BR-SHF-004
    note: text('note'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_roster_days_tenant_id_employee_id_date')
      .on(t.tenantId, t.employeeId, t.date)
      .where(sql`deleted_at IS NULL`),
    index('idx_roster_days_tenant_id_date').on(t.tenantId, t.date), // grid range scan
    index('idx_roster_days_tenant_id_shift_id').on(t.tenantId, t.shiftId), // shift archive guard
  ],
);
