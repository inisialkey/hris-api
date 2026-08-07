import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { RoleHolderPort } from '../../authz';
import type { OrgQueryPort } from '../../organization';
import type { SettingsPort } from '../../settings';
import type {
  ActionRepositoryPort,
  ApprovalOutboxPort,
  AssigneeRepositoryPort,
  DelegationRepositoryPort,
  StepRepositoryPort,
} from '../domain/approval.ports';
import type {
  ActionType,
  DelegationRow,
  InstanceRow,
  StepConfig,
  StepRow,
} from '../domain/approval.types';
import { ActivationService } from './activation.service';

/**
 * BR-APRV-006, BR-APRV-007 and BR-APRV-009, which meet in one act. §14 asks for
 * each vacancy policy, each self-approval policy, and the delegation rules —
 * all of them decisions this service makes over port answers, so all of them
 * testable without a database.
 */
describe('ActivationService (BR-APRV-006/007/009)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');
  const REQUESTER_EMPLOYEE = 'e-req';
  const REQUESTER_USER = 'u-req';

  let managersByLevel: Record<number, string[]>;
  let positionHolders: string[];
  let roleHolders: string[];
  let fallbackRoleId: string | null;
  let delegations: DelegationRow[];
  let assignedTo: { approverUserId: string; delegateOfUserId: string | null }[][];
  let decided: { id: string; status: string }[];
  let activated: string[];
  let actions: ActionType[];
  let emitted: { name: string; payload: Record<string, unknown> }[];

  beforeEach(() => {
    managersByLevel = { 1: ['u-mgr'] };
    positionHolders = [];
    roleHolders = ['u-hr'];
    fallbackRoleId = 'role-hr';
    delegations = [];
    assignedTo = [];
    decided = [];
    activated = [];
    actions = [];
    emitted = [];
  });

  const stepConfig = (over: Partial<StepConfig> = {}): StepConfig => ({
    quorum: 'any',
    resolvers: [{ type: 'direct_manager', levels: 1 }],
    onVacancy: { policy: 'fallback_role' },
    onSelfApproval: 'reroute_next_level',
    ...over,
  });

  const instance = (steps: StepConfig[]): InstanceRow => ({
    id: 'i-1',
    companyId: 'co-1',
    requestType: 'leave.request',
    requestId: 'r-1',
    requesterEmployeeId: REQUESTER_EMPLOYEE,
    requesterUserId: REQUESTER_USER,
    status: 'in_progress',
    chainSnapshot: { chainId: 'c-1', name: 'chain', priority: 100, steps },
    context: {},
    currentStepIndex: 0,
    isStuck: false,
    version: 1,
    completedAt: null,
    createdAt: NOW,
  });

  function build(): ActivationService {
    const steps = {
      findByIndex: (instanceId: string, stepIndex: number) =>
        Promise.resolve({
          id: `s-${stepIndex}`,
          instanceId,
          stepIndex,
          name: null,
          quorum: 'any',
          slaHours: null,
          status: 'pending',
          activatedAt: null,
          remindedAt: null,
          escalatedAt: null,
          decidedAt: null,
          version: 1,
        } as StepRow),
      activate: (id: string) => {
        activated.push(id);
        return Promise.resolve(true);
      },
      decide: (id: string, _version: number, status: string) => {
        decided.push({ id, status });
        return Promise.resolve(true);
      },
    } as unknown as StepRepositoryPort;

    const assignees = {
      createAll: (
        _stepId: string,
        rows: readonly { approverUserId: string; delegateOfUserId: string | null }[],
      ) => {
        assignedTo.push([...rows]);
        return Promise.resolve([]);
      },
    } as unknown as AssigneeRepositoryPort;

    const actionRepo = {
      append: (values: { action: ActionType }) => {
        actions.push(values.action);
        return Promise.resolve({} as never);
      },
    } as unknown as ActionRepositoryPort;

    const delegationRepo = {
      liveFor: (delegatorUserIds: readonly string[]) =>
        Promise.resolve(
          delegations.filter((row) => delegatorUserIds.includes(row.delegatorUserId)),
        ),
    } as unknown as DelegationRepositoryPort;

    const org = {
      directManagers: (_employeeId: string, levels: number) =>
        Promise.resolve(managersByLevel[levels] ?? []),
      positionHolders: () => Promise.resolve(positionHolders),
    } as unknown as OrgQueryPort;

    const roles = {
      holderUserIds: () => Promise.resolve(roleHolders),
      findIdByKey: () => Promise.resolve(fallbackRoleId),
    } as unknown as RoleHolderPort;

    const settings = { resolve: () => Promise.resolve('hr_admin') } as unknown as SettingsPort;

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        emitted.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    } as unknown as ApprovalOutboxPort;

    return new ActivationService(
      steps,
      assignees,
      actionRepo,
      delegationRepo,
      org,
      roles,
      settings,
      outbox,
      { now: () => NOW },
    );
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: REQUESTER_USER });
      return fn();
    });
  }

  it('assigns the resolved manager and announces the step', async () => {
    const outcome = await run(() => build().activateFrom(instance([stepConfig()]), 0));

    expect(outcome).toEqual({ activeStepIndex: 0, stuck: false });
    expect(assignedTo[0]).toEqual([{ approverUserId: 'u-mgr', delegateOfUserId: null }]);
    expect(emitted[0]?.name).toBe('approval.step.activated');
    expect(emitted[0]?.payload.assigneeUserIds).toEqual(['u-mgr']);
  });

  it('unions the resolvers rather than taking the first that answers', () => {
    positionHolders = ['u-head'];
    return run(async () => {
      await build().activateFrom(
        instance([
          stepConfig({
            resolvers: [
              { type: 'direct_manager', levels: 1 },
              { type: 'position_holder', positionId: 'p-1' },
            ],
          }),
        ]),
        0,
      );
      expect(assignedTo[0]?.map((row) => row.approverUserId).sort()).toEqual(['u-head', 'u-mgr']);
    });
  });

  describe('vacancy ladder', () => {
    beforeEach(() => {
      managersByLevel = {};
    });

    it('falls to the configured role and marks nothing stuck', async () => {
      const outcome = await run(() => build().activateFrom(instance([stepConfig()]), 0));
      expect(assignedTo[0]).toEqual([{ approverUserId: 'u-hr', delegateOfUserId: null }]);
      expect(outcome.stuck).toBe(false);
    });

    it('takes a fallback resolver when one is configured', async () => {
      positionHolders = ['u-head'];
      await run(() =>
        build().activateFrom(
          instance([
            stepConfig({
              onVacancy: {
                policy: 'fallback_resolver',
                resolver: { type: 'position_holder', positionId: 'p-1' },
              },
            }),
          ]),
          0,
        ),
      );
      expect(assignedTo[0]).toEqual([{ approverUserId: 'u-head', delegateOfUserId: null }]);
    });

    it('skips the step under `skip`, and reaches the next one in the same act', async () => {
      const outcome = await run(() =>
        build().activateFrom(
          instance([
            stepConfig({ onVacancy: { policy: 'skip' } }),
            stepConfig({ resolvers: [{ type: 'position_holder', positionId: 'p-2' }] }),
          ]),
          0,
        ),
      );
      // Step 1's position is vacant too, so it lands on the fallback role.
      expect(decided).toEqual([{ id: 's-0', status: 'skipped' }]);
      expect(actions).toEqual(['skipped']);
      expect(outcome.activeStepIndex).toBe(1);
    });

    it('leaves the step active with nobody on it and flags stuck at the last rung', async () => {
      roleHolders = [];
      const outcome = await run(() => build().activateFrom(instance([stepConfig()]), 0));

      expect(outcome).toEqual({ activeStepIndex: 0, stuck: true });
      expect(activated).toEqual(['s-0']);
      expect(assignedTo[0]).toEqual([]);
      // §12 registers no stuck event; an empty assignee list is the signal.
      expect(emitted[0]?.payload.assigneeUserIds).toEqual([]);
    });

    it('is still stuck when the tenant has no role with the fallback key', async () => {
      fallbackRoleId = null;
      const outcome = await run(() => build().activateFrom(instance([stepConfig()]), 0));
      expect(outcome.stuck).toBe(true);
    });
  });

  describe('self-approval guard', () => {
    it('reroutes one level up and records it on the trail', async () => {
      managersByLevel = { 1: [REQUESTER_USER], 2: ['u-boss'] };
      await run(() => build().activateFrom(instance([stepConfig()]), 0));

      expect(assignedTo[0]).toEqual([{ approverUserId: 'u-boss', delegateOfUserId: null }]);
      expect(actions).toEqual(['rerouted']);
    });

    it('reroutes from the deepest level the step already asked for', async () => {
      managersByLevel = { 2: [REQUESTER_USER], 3: ['u-boss'] };
      await run(() =>
        build().activateFrom(
          instance([stepConfig({ resolvers: [{ type: 'direct_manager', levels: 2 }] })]),
          0,
        ),
      );
      expect(assignedTo[0]).toEqual([{ approverUserId: 'u-boss', delegateOfUserId: null }]);
    });

    it('falls into the vacancy ladder when the reroute finds nobody either', async () => {
      managersByLevel = { 1: [REQUESTER_USER] };
      await run(() => build().activateFrom(instance([stepConfig()]), 0));
      expect(assignedTo[0]).toEqual([{ approverUserId: 'u-hr', delegateOfUserId: null }]);
    });

    it('skips the step under `skip_step`', async () => {
      managersByLevel = { 1: [REQUESTER_USER] };
      const outcome = await run(() =>
        build().activateFrom(instance([stepConfig({ onSelfApproval: 'skip_step' })]), 0),
      );
      expect(decided).toEqual([{ id: 's-0', status: 'skipped' }]);
      expect(outcome.activeStepIndex).toBeNull();
    });

    it('lets the requester act under `allow`', async () => {
      managersByLevel = { 1: [REQUESTER_USER] };
      await run(() => build().activateFrom(instance([stepConfig({ onSelfApproval: 'allow' })]), 0));
      expect(assignedTo[0]).toEqual([{ approverUserId: REQUESTER_USER, delegateOfUserId: null }]);
    });

    it('drops the requester again when a delegation points the item back at them', async () => {
      delegations = [
        {
          id: 'd-1',
          delegatorUserId: 'u-mgr',
          delegateUserId: REQUESTER_USER,
          requestTypes: null,
          startDate: '2026-03-01',
          endDate: '2026-03-31',
          revokedAt: null,
        },
      ];
      const outcome = await run(() => build().activateFrom(instance([stepConfig()]), 0));

      // A delegation is not an override of the self-approval guard.
      expect(assignedTo[0]).toEqual([]);
      expect(outcome.stuck).toBe(true);
    });
  });

  it('returns no active step when the whole chain skips — the instance is approved', async () => {
    managersByLevel = {};
    const outcome = await run(() =>
      build().activateFrom(instance([stepConfig({ onVacancy: { policy: 'skip' } })]), 0),
    );
    expect(outcome.activeStepIndex).toBeNull();
    expect(assignedTo).toEqual([]);
  });
});
