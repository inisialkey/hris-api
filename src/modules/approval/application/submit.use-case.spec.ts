import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { FIELD_ENTRIES } from '../../../shared/validation-details';
import type {
  ActionRepositoryPort,
  ApprovalDirectoryPort,
  ApprovalOutboxPort,
  ChainRepositoryPort,
  InstanceRepositoryPort,
  StepRepositoryPort,
} from '../domain/approval.ports';
import type { ChainRow, InstanceRow, StepConfig } from '../domain/approval.types';
import type { ActivationService } from './activation.service';
import { InstanceLifecycleService } from './lifecycle.service';
import { SubmitUseCase } from './submit.use-case';

/** `pg` rejects with an `Error` carrying `code` and `constraint`; the mapper reads both. */
function driverError(code: string, constraint: string): Error {
  return Object.assign(new Error(constraint), { code, constraint });
}

/** UC-APRV-001. */
describe('SubmitUseCase (UC-APRV-001)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let chains: ChainRow[];
  let createError: Error | null;
  let activeStepIndex: number | null;
  let stuck: boolean;
  let created: Record<string, unknown>[];
  let stepsCreated: StepConfig[][];
  let emitted: string[];
  let instancePatches: Record<string, unknown>[];
  let directoryHit: {
    employeeId: string;
    userId: string | null;
    companyId: string;
    fullName: string;
  } | null;

  const steps: StepConfig[] = [
    {
      quorum: 'any',
      resolvers: [{ type: 'direct_manager', levels: 1 }],
      onVacancy: { policy: 'fallback_role' },
      onSelfApproval: 'reroute_next_level',
    },
  ];

  beforeEach(() => {
    chains = [
      {
        id: 'c-tenant',
        companyId: null,
        requestType: 'leave.request',
        name: 'Default',
        priority: 100,
        conditions: null,
        steps,
        isActive: true,
      },
    ];
    createError = null;
    activeStepIndex = 0;
    stuck = false;
    created = [];
    stepsCreated = [];
    emitted = [];
    instancePatches = [];
    directoryHit = {
      employeeId: 'e-req',
      userId: 'u-req',
      companyId: 'co-1',
      fullName: 'Requester',
    };
  });

  function build(): SubmitUseCase {
    const chainRepo = {
      selectable: () => Promise.resolve(chains),
    } as unknown as ChainRepositoryPort;

    const instances = {
      create: (values: Record<string, unknown>) => {
        // `pg` rejects with a driver error object rather than an `Error`, and the
        // mapper reads `.code`/`.constraint` off exactly that shape.
        if (createError) return Promise.reject(createError);
        created.push(values);
        return Promise.resolve({
          ...values,
          id: 'i-1',
          status: 'in_progress',
          currentStepIndex: 0,
          isStuck: false,
          version: 1,
          completedAt: null,
          createdAt: NOW,
        } as unknown as InstanceRow);
      },
      advance: (_id: string, _version: number, patch: Record<string, unknown>) => {
        instancePatches.push(patch);
        return Promise.resolve(true);
      },
    } as unknown as InstanceRepositoryPort;

    const stepRepo = {
      createAll: (_instanceId: string, configs: readonly StepConfig[]) => {
        stepsCreated.push([...configs]);
        return Promise.resolve([]);
      },
      skipRemaining: () => Promise.resolve(),
    } as unknown as StepRepositoryPort;

    const actions = {
      append: () => Promise.resolve({} as never),
    } as unknown as ActionRepositoryPort;

    const directory = {
      byEmployeeId: () => Promise.resolve(directoryHit),
    } as unknown as ApprovalDirectoryPort;

    const activation = {
      activateFrom: () => Promise.resolve({ activeStepIndex, stuck }),
    } as unknown as ActivationService;

    const outbox = {
      emit: (event: { name: string }) => {
        emitted.push(event.name);
        return Promise.resolve();
      },
    } as unknown as ApprovalOutboxPort;

    return new SubmitUseCase(
      chainRepo,
      instances,
      stepRepo,
      actions,
      directory,
      activation,
      new InstanceLifecycleService(instances, stepRepo, outbox),
      { now: () => NOW },
    );
  }

  const submit = (context: Record<string, unknown> = {}) =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({ requestId: 'req-1', userId: 'u-req' });
      return build().submit({
        requestType: 'leave.request',
        requestId: 'r-1',
        requesterEmployeeId: 'e-req',
        context,
      });
    });

  it('snapshots the selected chain onto the instance (BR-APRV-004)', async () => {
    const result = await submit();

    expect(result.ok).toBe(true);
    expect(created[0]?.chainSnapshot).toEqual({
      chainId: 'c-tenant',
      name: 'Default',
      priority: 100,
      steps,
    });
    expect(stepsCreated[0]).toEqual(steps);
  });

  it('takes the company and the user from the directory, not from the context', async () => {
    // A wrong company in the context would silently select another company's
    // approvers, so the view is the authority on where somebody works.
    await submit({ companyId: 'co-somewhere-else' });
    expect(created[0]?.companyId).toBe('co-1');
    expect(created[0]?.requesterUserId).toBe('u-req');
  });

  it('fails APRV_NO_CHAIN_CONFIGURED when nothing matches', async () => {
    chains = [{ ...chains[0]!, conditions: [{ field: 'dayCount', op: 'gt', value: 5 }] }];

    const result = await submit({ dayCount: 1 });

    expect(!result.ok && result.error.code).toBe('APRV_NO_CHAIN_CONFIGURED');
    expect(!result.ok && result.error.details).toEqual({ requestType: 'leave.request' });
    expect(created).toEqual([]);
  });

  it('answers 404 for an employee the directory does not carry', async () => {
    directoryHit = null;
    const result = await submit();
    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('throws rather than fails when the requester has no login', async () => {
    // A requester who cannot be returned to is a module precondition violation,
    // not a state a user can be told about — and `requester_user_id` is NOT NULL.
    directoryHit = { ...directoryHit!, userId: null };
    await expect(submit()).rejects.toThrow(/no user account/);
  });

  it('turns the live-instance unique violation into a field-named duplicate', async () => {
    createError = driverError('23505', 'uq_approval_instances_live');

    const result = await submit();

    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(
      !result.ok &&
        ((result.error.details?.[FIELD_ENTRIES] ?? []) as { field: string }[])[0]?.field,
    ).toBe('requestId');
  });

  it('re-throws a constraint violation it does not own', async () => {
    createError = driverError('23503', 'approval_instances_company_id_companies_id_fk');
    await expect(submit()).rejects.toMatchObject({ code: '23503' });
  });

  it('approves immediately when the whole chain skipped, and says so', async () => {
    activeStepIndex = null;

    const result = await submit();

    expect(result.ok).toBe(true);
    expect(instancePatches).toEqual([{ status: 'approved' }]);
    expect(emitted).toEqual(['approval.instance.approved']);
  });

  it('advances the pointer when activation landed past step 0', async () => {
    activeStepIndex = 2;
    stuck = true;

    await submit();

    expect(instancePatches).toEqual([{ currentStepIndex: 2, isStuck: true }]);
  });
});
