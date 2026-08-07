import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type {
  ActionRepositoryPort,
  ApprovalOutboxPort,
  AssigneeRepositoryPort,
  InstanceRepositoryPort,
  StepRepositoryPort,
} from '../domain/approval.ports';
import type {
  ActionType,
  AssigneeRow,
  InstanceRow,
  InstanceStatus,
  StepRow,
} from '../domain/approval.types';
import type { ActivationService } from './activation.service';
import { DecideUseCase } from './decide.use-case';
import { InstanceLifecycleService } from './lifecycle.service';

/**
 * UC-APRV-002/003/004 and the `BR-APRV-008`/`013` rules they turn on. Every
 * failure here is a `Result`, never a throw — the module endpoint surfaces it
 * and the transaction rolls back with it (ADR-0006).
 */
describe('DecideUseCase (UC-APRV-002/003/004)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');
  const ACTOR = 'u-approver';

  let instanceRow: InstanceRow | null;
  let stepRow: StepRow | null;
  let seats: AssigneeRow[];
  let claimSucceeds: boolean;
  let stepDecideSucceeds: boolean;
  let nextActiveIndex: number | null;
  let emitted: string[];
  let actions: { action: ActionType; delegateOfUserId?: string | null; comment?: string | null }[];
  let stepDecisions: string[];
  let instancePatches: Record<string, unknown>[];
  let closedSteps: string[];

  const seat = (over: Partial<AssigneeRow> = {}): AssigneeRow => ({
    id: 'a-1',
    stepId: 's-0',
    approverUserId: ACTOR,
    delegateOfUserId: null,
    status: 'active',
    actedAt: null,
    version: 1,
    ...over,
  });

  beforeEach(() => {
    instanceRow = {
      id: 'i-1',
      companyId: 'co-1',
      requestType: 'leave.request',
      requestId: 'r-1',
      requesterEmployeeId: 'e-req',
      requesterUserId: 'u-req',
      status: 'in_progress',
      chainSnapshot: { chainId: 'c-1', name: 'chain', priority: 100, steps: [] },
      context: {},
      currentStepIndex: 0,
      isStuck: false,
      version: 1,
      completedAt: null,
      createdAt: NOW,
    };
    stepRow = {
      id: 's-0',
      instanceId: 'i-1',
      stepIndex: 0,
      name: null,
      quorum: 'any',
      slaHours: null,
      status: 'active',
      activatedAt: NOW,
      remindedAt: null,
      escalatedAt: null,
      decidedAt: null,
      version: 1,
    };
    seats = [seat()];
    claimSucceeds = true;
    stepDecideSucceeds = true;
    nextActiveIndex = null;
    emitted = [];
    actions = [];
    stepDecisions = [];
    instancePatches = [];
    closedSteps = [];
  });

  function build(): DecideUseCase {
    const instances = {
      findNewestForRequest: () => Promise.resolve(instanceRow),
      advance: (_id: string, _version: number, patch: Record<string, unknown>) => {
        instancePatches.push(patch);
        return Promise.resolve(true);
      },
    } as unknown as InstanceRepositoryPort;

    const steps = {
      findByIndex: () => Promise.resolve(stepRow),
      decide: (_id: string, _version: number, status: string) => {
        stepDecisions.push(status);
        return Promise.resolve(stepDecideSucceeds);
      },
      skipRemaining: () => Promise.resolve(),
    } as unknown as StepRepositoryPort;

    const assignees = {
      findSeat: (_stepId: string, userId: string) =>
        Promise.resolve(seats.find((row) => row.approverUserId === userId) ?? null),
      claim: (id: string, _version: number, status: AssigneeRow['status']) => {
        if (!claimSucceeds) return Promise.resolve(false);
        seats = seats.map((row) => (row.id === id ? { ...row, status } : row));
        return Promise.resolve(true);
      },
      listByStep: () => Promise.resolve(seats),
      closeRemaining: (stepId: string) => {
        closedSteps.push(stepId);
        return Promise.resolve();
      },
    } as unknown as AssigneeRepositoryPort;

    const actionRepo = {
      append: (values: { action: ActionType; delegateOfUserId?: string | null }) => {
        actions.push(values);
        return Promise.resolve({} as never);
      },
    } as unknown as ActionRepositoryPort;

    const outbox = {
      emit: (event: { name: string }) => {
        emitted.push(event.name);
        return Promise.resolve();
      },
    } as unknown as ApprovalOutboxPort;

    const activation = {
      activateFrom: () => Promise.resolve({ activeStepIndex: nextActiveIndex, stuck: false }),
    } as unknown as ActivationService;

    const lifecycle = new InstanceLifecycleService(instances, steps, outbox);

    return new DecideUseCase(instances, steps, assignees, actionRepo, activation, lifecycle, {
      now: () => NOW,
    });
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: ACTOR });
      return fn();
    });
  }

  const decide = (action: 'approve' | 'reject' | 'return', comment?: string, actor = ACTOR) =>
    run(() => build().decide(actor, 'leave.request', 'r-1', action, comment));

  it('approves an `any` step, ends the instance and emits the terminal event', async () => {
    const result = await decide('approve');

    expect(result.ok && result.value.instanceStatus).toBe('approved');
    expect(stepDecisions).toEqual(['approved']);
    expect(emitted).toEqual([
      'approval.assignee.acted',
      'approval.step.decided',
      'approval.instance.approved',
    ]);
  });

  it('holds an `all` step open on a partial approval and closes nobody', async () => {
    stepRow = { ...stepRow!, quorum: 'all' };
    seats = [seat({ id: 'a-1' }), seat({ id: 'a-2', approverUserId: 'u-other' })];

    const result = await decide('approve');

    expect(result.ok && result.value.stepStatus).toBe('active');
    expect(stepDecisions).toEqual([]);
    expect(closedSteps).toEqual([]);
    // The actor's own inbox item completes now, not at step end (§12, grilled).
    expect(emitted).toEqual(['approval.assignee.acted']);
  });

  it('lets one rejection terminate an `all` step whatever else approved', async () => {
    stepRow = { ...stepRow!, quorum: 'all' };
    seats = [
      seat({ id: 'a-1' }),
      seat({ id: 'a-2', approverUserId: 'u-other', status: 'approved' }),
    ];

    const result = await decide('reject', 'not this quarter');

    expect(result.ok && result.value.instanceStatus).toBe('rejected');
    expect(emitted).toContain('approval.instance.rejected');
  });

  it('activates the next step instead of ending the instance when one remains', async () => {
    nextActiveIndex = 1;
    const result = await decide('approve');

    expect(result.ok && result.value.instanceStatus).toBe('in_progress');
    expect(instancePatches).toEqual([{ currentStepIndex: 1, isStuck: false }]);
    expect(emitted).not.toContain('approval.instance.approved');
  });

  it('refuses a comment-less rejection before any state change', async () => {
    const result = await decide('reject', '   ');

    expect(!result.ok && result.error.code).toBe('APRV_COMMENT_REQUIRED');
    // Nothing claimed, nothing appended, nothing emitted: BR-APRV-008's "before".
    expect(actions).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('refuses a comment-less return for the same reason', async () => {
    const result = await decide('return');
    expect(!result.ok && result.error.code).toBe('APRV_COMMENT_REQUIRED');
  });

  it('returns the request and ends the instance whatever the quorum says', async () => {
    stepRow = { ...stepRow!, quorum: 'all' };
    seats = [seat({ id: 'a-1' }), seat({ id: 'a-2', approverUserId: 'u-other' })];

    const result = await decide('return', 'please attach the receipt');

    expect(result.ok && result.value.instanceStatus).toBe('returned');
    expect(stepDecisions).toEqual(['skipped']);
    expect(closedSteps).toEqual(['s-0']);
  });

  it('answers APRV_NOT_AN_APPROVER to a permission holder with no seat', async () => {
    const result = await decide('approve', undefined, 'u-stranger');
    expect(!result.ok && result.error.code).toBe('APRV_NOT_AN_APPROVER');
  });

  it('answers APRV_STEP_ALREADY_DECIDED when the seat was closed out under it', async () => {
    // The losing half of an `any`-quorum race, one statement late: the winner's
    // `closeRemaining` already ran. Having no seat and having a spent one are
    // different facts and get different codes.
    seats = [seat({ status: 'skipped' })];
    const result = await decide('approve');
    expect(!result.ok && result.error.code).toBe('APRV_STEP_ALREADY_DECIDED');
  });

  it('answers APRV_INSTANCE_NOT_ACTIONABLE on a terminal instance', async () => {
    instanceRow = { ...instanceRow!, status: 'cancelled' as InstanceStatus };
    const result = await decide('approve');

    expect(!result.ok && result.error.code).toBe('APRV_INSTANCE_NOT_ACTIONABLE');
    expect(!result.ok && result.error.details).toEqual({ status: 'cancelled' });
  });

  it('answers 404 when no instance exists for the request', async () => {
    instanceRow = null;
    const result = await decide('approve');
    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('loses a double-click at the assignee claim', async () => {
    claimSucceeds = false;
    const result = await decide('approve');

    expect(!result.ok && result.error.code).toBe('APRV_STEP_ALREADY_DECIDED');
    expect(emitted).toEqual([]);
  });

  it('loses the `any`-quorum race at the step version, after claiming its own seat', async () => {
    // Both approvers claim their own rows; the step-level guard decides which
    // one is the decision. The loser's whole transaction rolls back on this
    // failure, which is what undoes the claim above it.
    seats = [seat({ id: 'a-1' }), seat({ id: 'a-2', approverUserId: 'u-other' })];
    stepDecideSucceeds = false;

    const result = await decide('approve');
    expect(!result.ok && result.error.code).toBe('APRV_STEP_ALREADY_DECIDED');
  });

  it('records the delegate-of on the trail row when the seat was redirected', async () => {
    seats = [seat({ delegateOfUserId: 'u-original' })];
    await decide('approve');

    expect(actions[0]).toMatchObject({ action: 'approve', delegateOfUserId: 'u-original' });
  });
});
