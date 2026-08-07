import type { Result } from '../../../shared/result';
import type {
  ActionRow,
  ActionType,
  AssigneeRow,
  ChainRow,
  ChainSnapshot,
  Condition,
  DelegationRow,
  InstanceListRow,
  InstanceRow,
  InstanceStatus,
  RequestContext,
  SlaState,
  StepConfig,
  StepRow,
  StepStatus,
} from './approval.types';

/* ------------------------------------------------------------------------- *
 * The consumer contract — approval-engine §7's "Engine port (in-process)".
 * ------------------------------------------------------------------------- */

export const APPROVAL_PORT = Symbol('APPROVAL_PORT');

export interface SubmitCommand {
  requestType: string;
  requestId: string;
  requesterEmployeeId: string;
  context: RequestContext;
}

/**
 * What the calling module needs back to finish its own transaction.
 *
 * `instanceStatus` is the field that matters and the reason this is not `void`:
 * training.md UC-TRN-005 allocates a seat *"whenever the decision completes the
 * instance"*, which is a question only the engine can answer and which the
 * terminal event cannot answer in time — the event is dispatched after commit,
 * and the seat has to be taken inside it.
 */
export interface DecisionResult {
  instanceId: string;
  instanceStatus: InstanceStatus;
  stepIndex: number;
  stepStatus: StepStatus;
}

/**
 * ADR-0008's integration contract, and the only way a module touches an
 * instance (BR-APRV-001).
 *
 * **Every method runs in the caller's transaction** (§9: *"port call is same-tx
 * — rollback removes instance rows atomically"*). Two consequences a caller has
 * to hold up its end of:
 *
 * 1. A module that submits and then fails its own validation must let the
 *    failure reach the request boundary. `unwrap` throws and the transaction
 *    rolls back; a swallowed `Result` commits an instance for a request that
 *    does not exist.
 * 2. The same applies in reverse to a lost optimistic check (BR-APRV-013). The
 *    losing approver's assignee claim is undone only because the failure
 *    propagates — a module that catches `APRV_STEP_ALREADY_DECIDED` and commits
 *    anyway has consumed that approver's seat for nothing.
 *
 * Gate one — the module's static `@RequirePermission` — is the caller's. This
 * port is gate two (BR-APRV-012) and nothing else: it verifies the actor is a
 * live assignee of the active step, or their delegate.
 */
export interface ApprovalPort {
  /** UC-APRV-001. Fails `APRV_NO_CHAIN_CONFIGURED` when nothing matches. */
  submit(cmd: SubmitCommand): Promise<Result<{ instanceId: string }>>;
  /** UC-APRV-002. */
  approve(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment?: string,
  ): Promise<Result<DecisionResult>>;
  /** UC-APRV-003 — comment mandatory (BR-APRV-008). */
  reject(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment: string,
  ): Promise<Result<DecisionResult>>;
  /**
   * UC-APRV-004 — comment mandatory. Named as §7 names it; `return` is a legal
   * method name and renaming a contract method to avoid a keyword would make
   * this port the one place the handbook's vocabulary does not survive.
   */
  return(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment: string,
  ): Promise<Result<DecisionResult>>;
  /**
   * UC-APRV-005. Requester-only while `in_progress`; a module may refuse earlier
   * in its own endpoint (BR-APRV-011) but never later.
   */
  cancel(actorUserId: string, requestType: string, requestId: string): Promise<Result<void>>;
}

/* ------------------------------------------------------------------------- *
 * Ports consumed. `RoleHolderPort` is authz's and imported from its facade;
 * `OrgQueryPort` is organization's. Only the view read is declared here, because
 * a view has no owner to declare a port on (ADR-0001 rule 6).
 * ------------------------------------------------------------------------- */

export const APPROVAL_DIRECTORY = Symbol('APPROVAL_DIRECTORY');

export interface DirectoryEntry {
  employeeId: string;
  userId: string | null;
  companyId: string;
  fullName: string;
}

/**
 * `employee_directory`, ADR-0001 rule 6 — not a port on the employee module.
 * The engine needs the requester's company (the chain scope), their user id (the
 * instance's requester), and names for the timeline. All four columns are on the
 * published view, and a view join is what rule 6 exists for.
 */
export interface ApprovalDirectoryPort {
  byEmployeeId(employeeId: string): Promise<DirectoryEntry | null>;
  byUserIds(userIds: readonly string[]): Promise<Map<string, DirectoryEntry>>;
  /** BR-APRV-010's escalation target: assignee → their employee row → manager. */
  employeeIdOf(userId: string): Promise<string | null>;
}

/* ------------------------------------------------------------------------- *
 * Internal ports.
 * ------------------------------------------------------------------------- */

export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export const CHAIN_REPOSITORY = Symbol('CHAIN_REPOSITORY');

export interface ChainFilter {
  requestType?: string;
  companyId?: string;
  companyIds: string[] | null;
}

export interface ChainWrite {
  companyId: string | null;
  requestType: string;
  name: string;
  priority: number;
  conditions: Condition[] | null;
  steps: StepConfig[];
  isActive: boolean;
}

export interface ChainRepositoryPort {
  list(filter: ChainFilter, page: Page): Promise<Paged<ChainRow>>;
  /** BR-APRV-002's candidate set: live, active or not — selection filters. */
  selectable(requestType: string, companyId: string): Promise<ChainRow[]>;
  findById(id: string): Promise<ChainRow | null>;
  /** UC-APRV-008's catch-all guard — live chains of the type at the same scope. */
  siblings(requestType: string, companyId: string | null): Promise<ChainRow[]>;
  create(values: ChainWrite): Promise<ChainRow>;
  update(id: string, patch: Partial<ChainWrite>): Promise<ChainRow | null>;
  archive(id: string): Promise<boolean>;
}

export const INSTANCE_REPOSITORY = Symbol('INSTANCE_REPOSITORY');

export interface InstanceFilter {
  requestType?: string;
  status?: InstanceStatus;
  stuck?: boolean;
  slaState?: Exclude<SlaState, 'ok' | 'stuck'>;
  companyId?: string;
  companyIds: string[] | null;
}

export interface InstanceRepositoryPort {
  create(values: {
    companyId: string;
    requestType: string;
    requestId: string;
    requesterEmployeeId: string;
    requesterUserId: string;
    chainSnapshot: ChainSnapshot;
    context: RequestContext;
  }): Promise<InstanceRow>;
  findById(id: string): Promise<InstanceRow | null>;
  /** The newest instance for a request, terminal ones included (§7's second read). */
  findNewestForRequest(requestType: string, requestId: string): Promise<InstanceRow | null>;
  previousInstanceIds(requestType: string, requestId: string, exceptId: string): Promise<string[]>;
  list(filter: InstanceFilter, page: Page): Promise<Paged<InstanceListRow>>;
  /**
   * BR-APRV-013's optimistic write. `false` = the version moved, which is a
   * concurrent decision rather than a missing row.
   */
  advance(
    id: string,
    version: number,
    patch: { currentStepIndex?: number; status?: InstanceStatus; isStuck?: boolean },
    completedAt?: Date,
  ): Promise<boolean>;
}

export const STEP_REPOSITORY = Symbol('STEP_REPOSITORY');

export interface StepRepositoryPort {
  /** All steps of the snapshot, `pending`, in one statement (UC-APRV-001). */
  createAll(instanceId: string, steps: readonly StepConfig[]): Promise<StepRow[]>;
  listByInstance(instanceId: string): Promise<StepRow[]>;
  findByIndex(instanceId: string, stepIndex: number): Promise<StepRow | null>;
  activate(id: string, version: number, at: Date): Promise<boolean>;
  decide(id: string, version: number, status: StepStatus, at: Date): Promise<boolean>;
  /** UC-APRV-007's stamps — idempotency for a re-run of the same scan. */
  stamp(id: string, column: 'remindedAt' | 'escalatedAt', at: Date): Promise<void>;
  /** Steps still `pending` when the instance went terminal (BR-APRV-015's `skipped`). */
  skipRemaining(instanceId: string, fromIndex: number): Promise<void>;
  /** UC-APRV-007's scan: `active` steps carrying an SLA, oldest activation first. */
  dueForSla(now: Date): Promise<StepRow[]>;
}

export const ASSIGNEE_REPOSITORY = Symbol('ASSIGNEE_REPOSITORY');

export interface AssigneeRepositoryPort {
  createAll(
    stepId: string,
    assignments: readonly { approverUserId: string; delegateOfUserId: string | null }[],
  ): Promise<AssigneeRow[]>;
  listByStep(stepId: string): Promise<AssigneeRow[]>;
  listByInstance(instanceId: string): Promise<(AssigneeRow & { stepIndex: number })[]>;
  /**
   * The caller's seat on the step, **whatever its status**. Not filtered to
   * `active`, because "you have no seat here" and "your seat is already spent"
   * are two different answers (`APRV_NOT_AN_APPROVER` vs
   * `APRV_STEP_ALREADY_DECIDED`) and a filtered read collapses them into the
   * first one.
   */
  findSeat(stepId: string, approverUserId: string): Promise<AssigneeRow | null>;
  /**
   * BR-APRV-013's claim. `false` = the row was already acted on, which is the
   * double-click case and reads as `APRV_STEP_ALREADY_DECIDED`.
   */
  claim(id: string, version: number, status: StepStatus, at: Date): Promise<boolean>;
  /** Remaining `active` seats of a decided step, closed as `skipped`. */
  closeRemaining(stepId: string, at: Date): Promise<void>;
  /** BR-APRV-012's read set: has this user ever held a seat on the instance? */
  hasSeatOnInstance(instanceId: string, userId: string): Promise<boolean>;
}

export const ACTION_REPOSITORY = Symbol('ACTION_REPOSITORY');

export interface ActionRepositoryPort {
  /** BR-APRV-015 — append only; the table has no UPDATE grant to lose. */
  append(values: {
    instanceId: string;
    stepId?: string | null;
    actorUserId?: string | null;
    delegateOfUserId?: string | null;
    action: ActionType;
    comment?: string | null;
  }): Promise<ActionRow>;
  listByInstance(instanceId: string): Promise<ActionRow[]>;
}

export const DELEGATION_REPOSITORY = Symbol('DELEGATION_REPOSITORY');

export interface DelegationRepositoryPort {
  /** Every live delegation of the given delegators — activation's one read. */
  liveFor(delegatorUserIds: readonly string[], onDate: string): Promise<DelegationRow[]>;
  listForDelegator(delegatorUserId: string): Promise<DelegationRow[]>;
  list(filter: { delegatorUserId?: string }, page: Page): Promise<Paged<DelegationRow>>;
  findById(id: string): Promise<DelegationRow | null>;
  create(values: {
    delegatorUserId: string;
    delegateUserId: string;
    requestTypes: string[] | null;
    startDate: string;
    endDate: string;
  }): Promise<DelegationRow>;
  revoke(id: string, at: Date): Promise<boolean>;
  /**
   * Serialises overlap checking per delegator. The pre-check reads rows that do
   * not exist yet, so no row lock can cover it and no constraint expresses
   * "these two `text[]` scopes intersect over these two dates".
   */
  lockDelegator(delegatorUserId: string): Promise<void>;
}

export const APPROVAL_OUTBOX = Symbol('APPROVAL_OUTBOX');

/** §12's events, named rather than typed loose (coding-standards-nestjs §7). */
export type ApprovalEventName =
  | 'approval.step.activated'
  | 'approval.step.decided'
  | 'approval.assignee.acted'
  | 'approval.step.escalated'
  | 'approval.instance.approved'
  | 'approval.instance.rejected'
  | 'approval.instance.returned'
  | 'approval.instance.cancelled';

export interface ApprovalOutboxPort {
  emit(event: {
    name: ApprovalEventName;
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
