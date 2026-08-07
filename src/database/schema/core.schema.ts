// Core schema — core-schema.md §3–§8, applied verbatim.
//
// This file owns table shape, constraints and indexes only; every module's own
// tables live beside it under the same directory and are edited only alongside
// that module (backend-nestjs §2 rule 2). Ownership per core-schema §1.
//
// RLS is not expressed here. Drizzle cannot emit a policy, so each tenant-class
// table carries its `-- manual:` block in the migration that creates it —
// database-conventions §10 rule 4, and rule 8's reason: a separate "add
// policies" migration leaves a window where the table exists unguarded.

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { encryptedText } from '../../shared/crypto/encrypted-text';
import { auditColumns, id, softDeleteColumns, tenantId } from './_shared';

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'archived']);
export const userStatus = pgEnum('user_status', ['active', 'inactive', 'locked']);
export const devicePlatform = pgEnum('device_platform', ['android', 'ios']);
export const deviceStatus = pgEnum('device_status', ['active', 'revoked']);
export const employeeStatus = pgEnum('employee_status', [
  'active',
  'on_leave',
  'resigned',
  'terminated',
]);
export const employmentType = pgEnum('employment_type', ['pkwt', 'pkwtt']);

// employee.md §4.1's enums for the `employees` columns below. They live here
// rather than in `employee.schema.ts` for the same reason `employee_status` and
// `employment_type` already do — the columns that use them are on this table,
// and a schema file importing a value out of a file that imports it back is an
// ESM initialisation order bug waiting for the first import to land the other
// way round. `employee.schema.ts` declares the enums only *its* tables use.
export const gender = pgEnum('gender', ['male', 'female']);
export const maritalStatus = pgEnum('marital_status', ['single', 'married', 'divorced', 'widowed']);
export const religion = pgEnum('religion', [
  'islam',
  'protestant',
  'catholic',
  'hindu',
  'buddhist',
  'confucian',
]);
// > ⚠️ VERIFY: confirm against current Indonesian regulation before implementation.
// — the PTKP category set (employee.md §4.1).
export const ptkpStatus = pgEnum('ptkp_status', [
  'tk_0',
  'tk_1',
  'tk_2',
  'tk_3',
  'k_0',
  'k_1',
  'k_2',
  'k_3',
  'k_i_0',
  'k_i_1',
  'k_i_2',
  'k_i_3',
]);

export const tenants = pgTable(
  'tenants',
  {
    ...id,
    name: text('name').notNull(),
    slug: text('slug').notNull(), // stable machine name
    status: tenantStatus('status').notNull().default('active'),
    // D13 reserved — no billing logic in V1:
    plan: text('plan'),
    employeeLimit: integer('employee_limit'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_tenants_slug')
      .on(t.slug)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const platformUsers = pgTable(
  'platform_users',
  {
    ...id,
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_platform_users_email')
      .on(t.email)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const permissions = pgTable(
  'permissions',
  {
    // platform catalog, seeded from code
    ...id,
    key: text('key').notNull(), // 'leave.request.approve'
    module: text('module').notNull(), // ns from naming §4
    description: text('description').notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uq_permissions_key').on(t.key),
    index('idx_permissions_module').on(t.module),
  ],
);

export const users = pgTable(
  'users',
  {
    ...id,
    ...tenantId,
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_users_tenant_id_email')
      .on(t.tenantId, t.email)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    installId: uuid('install_id').notNull(), // client-generated per install (ADR-0004)
    platform: devicePlatform('platform').notNull(),
    model: text('model').notNull(),
    osVersion: text('os_version').notNull(),
    appVersion: text('app_version').notNull(),
    fcmToken: text('fcm_token'),
    status: deviceStatus('status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uq_devices_tenant_id_install_id_active')
      .on(t.tenantId, t.installId)
      .where(sql`status = 'active'`),
    index('idx_devices_tenant_id_user_id').on(t.tenantId, t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id), // null = web session
    refreshTokenHash: text('refresh_token_hash').notNull(), // sha256, rotates (ADR-0004)
    trustedDevice: boolean('trusted_device').notNull().default(false),
    mfaVerified: boolean('mfa_verified').notNull().default(false), // reserved, A-007
    ip: text('ip').notNull(),
    userAgent: text('user_agent'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // absolute cap
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uq_sessions_refresh_token_hash').on(t.refreshTokenHash),
    index('idx_sessions_tenant_id_user_id_live')
      .on(t.tenantId, t.userId)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const roles = pgTable(
  'roles',
  {
    ...id,
    ...tenantId,
    key: text('key').notNull(), // 'hr_admin' for system roles; slug for custom
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false), // immutable templates
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_roles_tenant_id_key')
      .on(t.tenantId, t.key)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    ...tenantId, // denormalized so RLS applies (conventions §2)
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index('idx_role_permissions_tenant_id_role_id').on(t.tenantId, t.roleId),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    ...id,
    ...tenantId,
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    companyId: uuid('company_id').references(() => companies.id), // NULL = tenant-wide (ADR-0005)
    ...auditColumns, // created_by = who granted
  },
  (t) => [
    uniqueIndex('uq_user_roles_assignment').on(t.tenantId, t.userId, t.roleId, t.companyId), // manual: NULLS NOT DISTINCT (§10)
    index('idx_user_roles_tenant_id_user_id').on(t.tenantId, t.userId),
  ],
);

export const companies = pgTable(
  'companies',
  {
    ...id,
    ...tenantId,
    code: text('code').notNull(), // human key for imports/numbers
    name: text('name').notNull(),
    // Legal identity — organization.md §4.1, added by that module's migration.
    // All nullable: provisioning creates the company (BR-ADM-006) and an admin
    // fills these in afterwards, so a NOT NULL here would block the tenant's
    // first transaction on data nobody has typed yet.
    legalName: text('legal_name'), // PT ... as registered
    npwp: text('npwp'), // corporate tax id — printed on tax documents, outside ADR-0016 scope
    address: text('address'),
    phone: text('phone'),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_companies_tenant_id_code')
      .on(t.tenantId, t.code)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const employees = pgTable(
  'employees',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id), // §5.6: one company
    userId: uuid('user_id').references(() => users.id), // null = no login (e.g. pre-onboarding)
    employeeNumber: text('employee_number').notNull(), // counters-generated (conventions §6)
    fullName: text('full_name').notNull(),
    joinDate: date('join_date').notNull(),
    employmentType: employmentType('employment_type').notNull(),
    status: employeeStatus('status').notNull().default('active'),

    // ------------------------------------------------------------------
    // employee.md §4.1 — master data, added by that module's migration.
    // The ADR-0016 encrypted set uses `encryptedText`: repositories see
    // plaintext, storage sees `v1:`-prefixed AEAD, and BR-AUD-005 layer 1
    // masks the audit diff off the column type without a list.
    // ------------------------------------------------------------------
    nik: encryptedText('nik').notNull(), // ADR-0016
    nikBidx: text('nik_bidx').notNull(), // BR-EMP-004
    npwp: encryptedText('npwp'), // NULL = no NPWP (NIK-as-NPWP era)
    npwpBidx: text('npwp_bidx'),
    bpjsKesehatanNumber: encryptedText('bpjs_kesehatan_number'),
    bpjsKetenagakerjaanNumber: encryptedText('bpjs_ketenagakerjaan_number'),
    bankName: text('bank_name'),
    bankAccountNumber: encryptedText('bank_account_number'),
    bankAccountHolder: encryptedText('bank_account_holder'),
    birthPlace: text('birth_place'),
    birthDate: date('birth_date').notNull(),
    gender: gender('gender').notNull(),
    maritalStatus: maritalStatus('marital_status').notNull(),
    religion: religion('religion'), // THR mapping (A-020); payroll validates presence
    ptkpStatus: ptkpStatus('ptkp_status').notNull(), // plaintext by ADR-0016 decision 1
    address: text('address'),
    phone: text('phone'),
    personalEmail: text('personal_email'),

    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [
    uniqueIndex('uq_employees_tenant_id_company_id_number')
      .on(t.tenantId, t.companyId, t.employeeNumber)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('uq_employees_tenant_id_user_id')
      .on(t.tenantId, t.userId)
      .where(sql`user_id IS NOT NULL AND deleted_at IS NULL`),
    index('idx_employees_tenant_id_company_id_status').on(t.tenantId, t.companyId, t.status),
  ],
);

export const counters = pgTable(
  'counters',
  {
    // business numbers, conventions §6
    ...id,
    ...tenantId,
    companyId: uuid('company_id').references(() => companies.id), // NULL = tenant-level counter
    key: text('key').notNull(), // 'employee_number', 'payslip_number'
    currentValue: integer('current_value').notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uq_counters_scope').on(t.tenantId, t.companyId, t.key), // manual: NULLS NOT DISTINCT
  ],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    // outbox, ADR-0010
    ...id, // uuidv7 = time-ordered relay cursor
    name: text('name').notNull(), // 'leave.request.approved'
    tenantId: uuid('tenant_id').references(() => tenants.id), // NULL = platform-level event
    aggregateId: uuid('aggregate_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    requestId: text('request_id'),
    version: integer('version').notNull().default(1), // payload schema version
    payload: jsonb('payload').notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_domain_events_undispatched')
      .on(t.id)
      .where(sql`dispatched_at IS NULL`),
  ],
);

export const processedEvents = pgTable(
  'processed_events',
  {
    // consumer idempotency guard
    consumer: text('consumer').notNull(), // 'notifications.on.leave.request.approved'
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.consumer, t.eventId] })],
);
