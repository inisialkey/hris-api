// approval-engine.md §4, applied verbatim.
//
// Six tables and one shape that is deliberately **not** a table: the step
// configuration lives in `jsonb` on both the chain and the instance snapshot,
// because §4 says so and because the two reads this module makes of it are
// "give me the whole chain" and "give me the chain this instance froze". Nothing
// queries a step row of a *config*; the executing steps are rows.
//
// `chain_snapshot` is BR-APRV-004 in one column: a config edit never reaches an
// instance already running, so the engine reads the snapshot and never the chain
// after submit. That is also why there is no FK from an instance to its chain —
// deleting a chain must not orphan an instance whose behaviour no longer depends
// on it.
//
// `request_id` carries no FK on purpose (ADR-0001): the row it points at belongs
// to leave, overtime, expense, and five other modules, and a foreign key would
// be the engine reaching into a domain table the boundary forbids it to know.
//
// RLS, the append-only revoke and the partial unique ride the generating
// migration (database-conventions §10 rule 4).

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, id, softDeleteColumns, tenantId, versionColumn } from './_shared';
import { companies, employees, users } from './core.schema';

export const approvalQuorum = pgEnum('approval_quorum', ['all', 'any']);

export const approvalInstanceStatus = pgEnum('approval_instance_status', [
  'in_progress',
  'approved',
  'rejected',
  'returned',
  'cancelled',
]);

export const approvalStepStatus = pgEnum('approval_step_status', [
  'pending',
  'active',
  'approved',
  'rejected',
  'skipped',
]);

export const approvalActionType = pgEnum('approval_action_type', [
  'submit',
  'approve',
  'reject',
  'return',
  'cancel',
  'reminded',
  'escalated',
  'skipped',
  'rerouted',
]);

export const approvalChains = pgTable(
  'approval_chains',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id').references(() => companies.id), // NULL = tenant-wide
    requestType: text('request_type').notNull(), // registry, §13
    name: text('name').notNull(),
    priority: integer('priority').notNull().default(100), // ascending; first match wins
    conditions: jsonb('conditions'), // ordered [{ field, op, value }] — NULL/[] = always match
    steps: jsonb('steps').notNull(), // §4's step config shape
    isActive: boolean('is_active').notNull().default(true),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (t) => [index('idx_approval_chains_lookup').on(t.tenantId, t.requestType, t.companyId)],
);

export const approvalInstances = pgTable(
  'approval_instances',
  {
    ...id,
    ...tenantId,
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id), // requester's company at submit
    requestType: text('request_type').notNull(),
    requestId: uuid('request_id').notNull(), // module row id — no FK (ADR-0001 boundary)
    requesterEmployeeId: uuid('requester_employee_id')
      .notNull()
      .references(() => employees.id),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id),
    status: approvalInstanceStatus('status').notNull().default('in_progress'),
    chainSnapshot: jsonb('chain_snapshot').notNull(), // BR-APRV-004
    context: jsonb('context').notNull(), // module-declared fields
    currentStepIndex: integer('current_step_index').notNull().default(0),
    isStuck: boolean('is_stuck').notNull().default(false), // BR-APRV-006
    ...versionColumn,
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex('uq_approval_instances_live')
      .on(t.tenantId, t.requestType, t.requestId)
      .where(sql`status = 'in_progress'`),
    index('idx_approval_instances_oversight').on(t.tenantId, t.companyId, t.status),
  ],
);

export const approvalSteps = pgTable(
  'approval_steps',
  {
    ...id,
    ...tenantId,
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => approvalInstances.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    name: text('name'),
    quorum: approvalQuorum('quorum').notNull(),
    slaHours: integer('sla_hours'), // NULL = no SLA
    status: approvalStepStatus('status').notNull().default('pending'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...versionColumn,
  },
  (t) => [
    uniqueIndex('uq_approval_steps_instance_idx').on(t.instanceId, t.stepIndex),
    index('idx_approval_steps_sla_scan').on(t.tenantId, t.status, t.activatedAt),
  ],
);

export const approvalAssignees = pgTable(
  'approval_assignees',
  {
    ...id,
    ...tenantId,
    stepId: uuid('step_id')
      .notNull()
      .references(() => approvalSteps.id, { onDelete: 'cascade' }),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id),
    delegateOfUserId: uuid('delegate_of_user_id').references(() => users.id), // BR-APRV-009
    status: approvalStepStatus('status').notNull().default('active'),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    ...versionColumn,
  },
  (t) => [
    uniqueIndex('uq_approval_assignees_step_user').on(t.stepId, t.approverUserId),
    index('idx_approval_assignees_inbox').on(t.tenantId, t.approverUserId, t.status), // inbox source
  ],
);

/** The immutable trail, BR-APRV-015. `UPDATE`/`DELETE` are revoked in the migration. */
export const approvalActions = pgTable(
  'approval_actions',
  {
    ...id,
    ...tenantId,
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => approvalInstances.id),
    stepId: uuid('step_id').references(() => approvalSteps.id), // NULL = instance-level
    actorUserId: uuid('actor_user_id'), // NULL = system (reminded/escalated)
    delegateOfUserId: uuid('delegate_of_user_id').references(() => users.id),
    action: approvalActionType('action').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_approval_actions_instance').on(t.instanceId, t.createdAt)],
);

export const approvalDelegations = pgTable(
  'approval_delegations',
  {
    ...id,
    ...tenantId,
    delegatorUserId: uuid('delegator_user_id')
      .notNull()
      .references(() => users.id),
    delegateUserId: uuid('delegate_user_id')
      .notNull()
      .references(() => users.id),
    requestTypes: text('request_types').array(), // NULL = all types
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index('idx_approval_delegations_lookup').on(
      t.tenantId,
      t.delegatorUserId,
      t.startDate,
      t.endDate,
    ),
  ],
);
