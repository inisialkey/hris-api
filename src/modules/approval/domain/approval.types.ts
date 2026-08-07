// The engine's vocabulary. Framework-free — no Nest, no Drizzle — so the rules
// in this folder are testable without either (backend-nestjs §3).
//
// The string unions are hand-written rather than derived from the pgEnum, which
// is the idiom organization and employee both use: a domain type that imports a
// schema file makes `domain/` depend on `src/database/`, and the enum values are
// a contract in approval-engine §4 either way.

export type Quorum = 'all' | 'any';

export type InstanceStatus = 'in_progress' | 'approved' | 'rejected' | 'returned' | 'cancelled';

export type StepStatus = 'pending' | 'active' | 'approved' | 'rejected' | 'skipped';

export type ActionType =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'return'
  | 'cancel'
  | 'reminded'
  | 'escalated'
  | 'skipped'
  | 'rerouted';

/** The four terminal instance statuses — everything except `in_progress`. */
export const TERMINAL_INSTANCE_STATUSES: readonly InstanceStatus[] = [
  'approved',
  'rejected',
  'returned',
  'cancelled',
];

/* ------------------------------------------------------------------------- *
 * Chain configuration — §4's step config shape, and what a snapshot freezes.
 * ------------------------------------------------------------------------- */

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export const CONDITION_OPS: readonly ConditionOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'];

export interface Condition {
  field: string;
  op: ConditionOp;
  value: unknown;
}

export type Resolver =
  | { type: 'direct_manager'; levels: number }
  | { type: 'position_holder'; positionId: string }
  | { type: 'role_holders'; roleId: string }
  | { type: 'specific_user'; userId: string };

export type ResolverType = Resolver['type'];

export const RESOLVER_TYPES: readonly ResolverType[] = [
  'direct_manager',
  'position_holder',
  'role_holders',
  'specific_user',
];

export type VacancyPolicy =
  | { policy: 'skip' }
  | { policy: 'fallback_resolver'; resolver: Resolver }
  | { policy: 'fallback_role' };

export type SelfApprovalPolicy = 'reroute_next_level' | 'skip_step' | 'allow';

export const SELF_APPROVAL_POLICIES: readonly SelfApprovalPolicy[] = [
  'reroute_next_level',
  'skip_step',
  'allow',
];

export interface StepConfig {
  name?: string;
  quorum: Quorum;
  slaHours?: number;
  /** ≥ 1; the union of everything they resolve to is the step's approver set. */
  resolvers: Resolver[];
  onVacancy: VacancyPolicy;
  onSelfApproval: SelfApprovalPolicy;
}

/**
 * BR-APRV-004's frozen copy. It carries the chain's identity so an oversight
 * reader can see *which* chain ran, and the steps as they were — not as they
 * are now.
 */
export interface ChainSnapshot {
  chainId: string;
  name: string;
  priority: number;
  steps: StepConfig[];
}

/** Module-declared fields (§13). Values are primitives or arrays of primitives. */
export type RequestContext = Record<string, unknown>;

/* ------------------------------------------------------------------------- *
 * Rows.
 * ------------------------------------------------------------------------- */

export interface ChainRow {
  id: string;
  companyId: string | null;
  requestType: string;
  name: string;
  priority: number;
  conditions: Condition[] | null;
  steps: StepConfig[];
  isActive: boolean;
}

export interface InstanceRow {
  id: string;
  companyId: string;
  requestType: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterUserId: string;
  status: InstanceStatus;
  chainSnapshot: ChainSnapshot;
  context: RequestContext;
  currentStepIndex: number;
  isStuck: boolean;
  version: number;
  completedAt: Date | null;
  createdAt: Date;
}

export interface StepRow {
  id: string;
  instanceId: string;
  stepIndex: number;
  name: string | null;
  quorum: Quorum;
  slaHours: number | null;
  status: StepStatus;
  activatedAt: Date | null;
  remindedAt: Date | null;
  escalatedAt: Date | null;
  decidedAt: Date | null;
  version: number;
}

export interface AssigneeRow {
  id: string;
  stepId: string;
  approverUserId: string;
  delegateOfUserId: string | null;
  status: StepStatus;
  actedAt: Date | null;
  version: number;
}

export interface ActionRow {
  id: string;
  instanceId: string;
  stepId: string | null;
  actorUserId: string | null;
  delegateOfUserId: string | null;
  action: ActionType;
  comment: string | null;
  createdAt: Date;
}

export interface DelegationRow {
  id: string;
  delegatorUserId: string;
  delegateUserId: string;
  requestTypes: string[] | null;
  startDate: string;
  endDate: string;
  revokedAt: Date | null;
}

/* ------------------------------------------------------------------------- *
 * Read shapes — §7's two instance responses.
 * ------------------------------------------------------------------------- */

/**
 * §7's oversight column, derived rather than stored: `escalated_at` and
 * `reminded_at` on the active step already say it, and a stored copy would be a
 * second thing the SLA scan has to keep true.
 */
export type SlaState = 'ok' | 'reminded' | 'escalated' | 'stuck';

export interface InstanceListRow {
  id: string;
  requestType: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string | null;
  status: InstanceStatus;
  currentStepIndex: number;
  stepCount: number;
  isStuck: boolean;
  slaState: SlaState;
  createdAt: Date;
  completedAt: Date | null;
}

export interface TimelineAssignee extends AssigneeRow {
  name: string | null;
  delegateOfName: string | null;
}

export interface TimelineAction extends ActionRow {
  actorName: string | null;
  stepIndex: number | null;
}
