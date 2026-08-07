// employee.md §4.1, applied verbatim — the satellites of `employees`.
//
// `employees` itself is core-schema §7's and lives in `core.schema.ts`; this
// module's migration extends it with the ADR-0016 encrypted set and the §4.1
// master columns, and the enums those columns use are declared beside them for
// ESM initialisation-order reasons stated there.
//
// **Three of §4.1's six tables are absent, and the reason is dependency order
// rather than scope.** `employee_documents` needs `files`, which
// document-storage owns (spine order 5). `employee_data_change_requests` and
// `employee_resignations` need `approval_instances`, which the approval engine
// owns (spine order 4). Both arrive with their dependency; the business rules
// they carry — BR-EMP-009, BR-EMP-010 — are unimplemented until then and named
// in A-195 rather than half-built here.
//
// RLS and the hand-written constraints ride the generating migration
// (database-conventions §10 rule 4).

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  pgView,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, id, softDeleteColumns, tenantId } from './_shared';
import { employeeStatus, employees, employmentType } from './core.schema';

export const familyRelationship = pgEnum('family_relationship', [
  'spouse',
  'child',
  'parent',
  'sibling',
  'other',
]);

export const employeeStatusSource = pgEnum('employee_status_source', [
  'hire',
  'resignation',
  'termination',
  'leave',
  'admin',
]);

export const employeeContracts = pgTable(
  'employee_contracts',
  {
    ...id,
    ...tenantId,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    kind: employmentType('kind').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'), // NULL = PKWTT (ck_employee_contracts_end_by_kind)
    // FK-less on arrival: `files` does not exist yet (document-storage, spine
    // order 5). The settings precedent — `setting_values.branch_id` shipped the
    // same way and organization's migration closed it. `fk_employee_contracts_files`
    // is document-storage's migration to write, because fulfilling a deferral
    // needs a table to alter. Expiry stays NULL by BR-EMP-007: the end-date
    // ladder is the reminder, not file expiry.
    fileId: uuid('file_id'),
    note: text('note'),
    lastRemindedDays: integer('last_reminded_days'), // BR-EMP-008 ladder stamp
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    index('idx_employee_contracts_tenant_id_employee_id_start_date').on(
      t.tenantId,
      t.employeeId,
      t.startDate,
    ),
    index('idx_employee_contracts_reminder_scan')
      .on(t.tenantId, t.endDate)
      .where(sql`kind = 'pkwt' AND deleted_at IS NULL`), // BR-EMP-008
  ],
);

export const employeeStatusHistory = pgTable(
  'employee_status_history',
  {
    ...id,
    ...tenantId,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    status: employeeStatus('status').notNull(),
    source: employeeStatusSource('source').notNull(),
    sourceId: uuid('source_id'), // resignation/leave row when applicable
    effectiveDate: date('effective_date').notNull(),
    reason: text('reason'),
    appliedAt: timestamp('applied_at', { withTimezone: true }), // NULL = scheduled
    ...auditColumns,
    ...softDeleteColumns, // soft delete = cancelled schedule
  },
  (t) => [
    index('idx_employee_status_history_tenant_id_employee_id_effective_date').on(
      t.tenantId,
      t.employeeId,
      t.effectiveDate,
    ),
    index('idx_employee_status_history_due')
      .on(t.tenantId, t.effectiveDate)
      .where(sql`applied_at IS NULL AND deleted_at IS NULL`), // effectuate scan
  ],
);

export const employeeFamilyMembers = pgTable(
  'employee_family_members',
  {
    ...id,
    ...tenantId,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    name: text('name').notNull(),
    relationship: familyRelationship('relationship').notNull(),
    birthDate: date('birth_date'),
    phone: text('phone'),
    isEmergencyContact: boolean('is_emergency_contact').notNull().default(false),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [index('idx_employee_family_members_tenant_id_employee_id').on(t.tenantId, t.employeeId)],
);

/**
 * `employee_directory` — the published read-model view of employee.md §13, and
 * ADR-0001 rule 6's third cross-module channel.
 *
 * `security_invoker = true` is **mandatory and not stylistic**: without it the
 * view executes with its owner's rights and silently bypasses the `employees`
 * RLS policy, which turns a convenience join into a cross-tenant read. The leak
 * matrix covers it beside the base table.
 *
 * `join_date` is here and is not in the handbook's column list yet — see A-195.
 * organization's placement rules need it (a move may not precede the employment
 * it moves) and the column is neither ADR-0016 encrypted nor BR-EMP-003 masked,
 * so it sits inside the boundary this view defines. It is the addition the entry
 * anticipated: *"Additions require an edit here and a consumer that needs them."*
 */
export const employeeDirectory = pgView('employee_directory', {
  employeeId: uuid('employee_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  companyId: uuid('company_id').notNull(),
  userId: uuid('user_id'),
  employeeNumber: text('employee_number').notNull(),
  fullName: text('full_name').notNull(),
  status: employeeStatus('status').notNull(),
  joinDate: date('join_date').notNull(),
})
  .with({ securityInvoker: true })
  .as(
    sql`SELECT id AS employee_id, tenant_id, company_id, user_id, employee_number, full_name, status, join_date
        FROM employees
        WHERE deleted_at IS NULL`,
  );
