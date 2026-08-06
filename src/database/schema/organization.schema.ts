// Organization schema — organization.md §4.1, applied verbatim.
//
// `companies` is not here: core-schema §7 defines it and this module only extends
// it with legal identity, so the four columns live beside the rest of the table in
// `core.schema.ts` rather than in a second `pgTable` Drizzle could not merge.
// The migration that creates the tables below is where the extension lands.
//
// Three constraints §4.1 declares are hand-written in that migration, because
// drizzle-kit can express none of them: the timezone CHECK, the paired-coordinate
// CHECK, and the gist exclusion that makes "one live placement per employee" a
// database fact rather than a hope (database-conventions §5.2).

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, effectiveDating, id, softDeleteColumns, tenantId } from './_shared';
import { companies, employees } from './core.schema';

/** BR-ORG-009: descriptive metadata for history and reports, never enforced state. */
export const orgAssignmentKind = pgEnum('org_assignment_kind', [
  'hire',
  'transfer',
  'promotion',
  'correction',
]);

export const branches = pgTable(
  'branches',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(), // human key for imports
    name: text('name').notNull(),
    timezone: text('timezone').notNull(), // IANA; CHECK: 3 Indonesian zones (BR-ORG-001)
    address: text('address'),
    // Geofence centre. The radius is attendance policy and lives in settings, not
    // on the row — a branch does not own how far away a punch may be taken from it.
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_branches_tenant_id_company_id_code')
      .on(t.tenantId, t.companyId, t.code)
      .where(sql`deleted_at IS NULL`),
    index('idx_branches_tenant_id_company_id').on(t.tenantId, t.companyId),
  ],
);

export const departments = pgTable(
  'departments',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    parentDepartmentId: uuid('parent_department_id').references((): AnyPgColumn => departments.id), // NULL = top level
    code: text('code').notNull(),
    name: text('name').notNull(),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_departments_tenant_id_company_id_code')
      .on(t.tenantId, t.companyId, t.code)
      .where(sql`deleted_at IS NULL`),
    index('idx_departments_tenant_id_parent').on(t.tenantId, t.parentDepartmentId),
  ],
);

export const jobLevels = pgTable(
  'job_levels',
  {
    // tenant-wide grade bands — no company_id, which is what makes configuring
    // them require a tenant-wide assignment (§2)
    ...id,
    ...tenantId,
    code: text('code').notNull(),
    name: text('name').notNull(),
    rank: integer('rank').notNull(), // ordering only; ties allowed (parallel bands)
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_job_levels_tenant_id_code')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const positions = pgTable(
  'positions',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    jobLevelId: uuid('job_level_id')
      .notNull()
      .references(() => jobLevels.id),
    code: text('code').notNull(),
    title: text('title').notNull(),
    reportsToPositionId: uuid('reports_to_position_id').references((): AnyPgColumn => positions.id), // NULL = top of a reporting tree
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_positions_tenant_id_company_id_code')
      .on(t.tenantId, t.companyId, t.code)
      .where(sql`deleted_at IS NULL`),
    index('idx_positions_tenant_id_department').on(t.tenantId, t.departmentId),
    index('idx_positions_tenant_id_reports_to').on(t.tenantId, t.reportsToPositionId),
  ],
);

export const orgAssignments = pgTable(
  'org_assignments',
  {
    ...id,
    ...tenantId,
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    kind: orgAssignmentKind('kind').notNull(),
    note: text('note'),
    ...effectiveDating,
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    index('idx_org_assignments_tenant_id_employee_id_effective_from').on(
      t.tenantId,
      t.employeeId,
      t.effectiveFrom,
    ),
    index('idx_org_assignments_tenant_id_position_id').on(t.tenantId, t.positionId), // positionHolders
    index('idx_org_assignments_tenant_id_branch_id').on(t.tenantId, t.branchId), // branch archive guard
  ],
);
