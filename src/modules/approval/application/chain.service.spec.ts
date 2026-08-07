import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { FIELD_ENTRIES } from '../../../shared/validation-details';
import type { RoleHolderPort } from '../../authz';
import type { OrgQueryPort } from '../../organization';
import type { SettingsPort } from '../../settings';
import type {
  ApprovalDirectoryPort,
  ChainRepositoryPort,
  ChainWrite,
} from '../domain/approval.ports';
import type { ChainRow } from '../domain/approval.types';
import { ChainService } from './chain.service';

const UUID = '01931b7c-0000-7000-8000-000000000001';

/**
 * UC-APRV-008. Everything §8 can check synchronously lives in `step-config.ts`
 * and is tested there; what is left here is the part that needs ports — the
 * reference checks — and the two rules about a chain *set* rather than a chain.
 */
describe('ChainService (UC-APRV-008)', () => {
  const COMPANY = 'co-1';

  let chains: ChainRow[];
  let created: ChainWrite[];
  let updated: { id: string; patch: Partial<ChainWrite> }[];
  let archived: string[];
  let positionExists: boolean;
  let roleExists: boolean;
  let knownUsers: string[];

  const chain = (over: Partial<ChainRow> & { id: string }): ChainRow => ({
    companyId: COMPANY,
    requestType: 'leave.request',
    name: over.id,
    priority: 100,
    conditions: null,
    steps: [],
    isActive: true,
    ...over,
  });

  const validStep = {
    quorum: 'any',
    resolvers: [{ type: 'direct_manager', levels: 1 }],
    onVacancy: { policy: 'fallback_role' },
    onSelfApproval: 'reroute_next_level',
  };

  beforeEach(() => {
    chains = [];
    created = [];
    updated = [];
    archived = [];
    positionExists = true;
    roleExists = true;
    knownUsers = [UUID];
  });

  function build(): ChainService {
    const repository = {
      list: () => Promise.resolve({ rows: chains, total: chains.length }),
      findById: (id: string) => Promise.resolve(chains.find((row) => row.id === id) ?? null),
      siblings: () => Promise.resolve(chains),
      create: (values: ChainWrite) => {
        created.push(values);
        return Promise.resolve(chain({ id: 'new', ...values }));
      },
      update: (id: string, patch: Partial<ChainWrite>) => {
        updated.push({ id, patch });
        return Promise.resolve(chains.find((row) => row.id === id) ?? null);
      },
      archive: (id: string) => {
        archived.push(id);
        return Promise.resolve(true);
      },
    } as unknown as ChainRepositoryPort;

    const org = {
      positionExists: () => Promise.resolve(positionExists),
    } as unknown as OrgQueryPort;
    const roles = { exists: () => Promise.resolve(roleExists) } as unknown as RoleHolderPort;
    const directory = {
      byUserIds: (ids: readonly string[]) =>
        Promise.resolve(new Map(ids.filter((id) => knownUsers.includes(id)).map((id) => [id, {}]))),
    } as unknown as ApprovalDirectoryPort;
    const settings = { resolve: () => Promise.resolve(5) } as unknown as SettingsPort;

    return new ChainService(repository, org, roles, directory, settings);
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'req-1',
        userId: 'u-admin',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope: 'all' }),
        },
      });
      return fn();
    });
  }

  const fieldsOf = (error: { details?: Record<string, unknown> }) =>
    ((error.details?.[FIELD_ENTRIES] ?? []) as { field: string }[]).map((entry) => entry.field);

  it('creates a chain with defaults §7 states', async () => {
    const result = await run(() =>
      build().create({
        requestType: 'leave.request',
        companyId: COMPANY,
        name: 'Manager only',
        steps: [validStep],
      }),
    );

    expect(result.ok).toBe(true);
    expect(created[0]).toMatchObject({ priority: 100, isActive: true, conditions: null });
  });

  it('refuses a request type that is not in §13’s registry', async () => {
    const result = await run(() =>
      build().create({ requestType: 'invented.thing', name: 'X', steps: [validStep] }),
    );

    expect(!result.ok && fieldsOf(result.error)).toEqual(['requestType']);
  });

  it('refuses a resolver naming a position that is not live', async () => {
    positionExists = false;
    const result = await run(() =>
      build().create({
        requestType: 'leave.request',
        companyId: COMPANY,
        name: 'X',
        steps: [{ ...validStep, resolvers: [{ type: 'position_holder', positionId: UUID }] }],
      }),
    );

    expect(!result.ok && fieldsOf(result.error)).toEqual(['steps[0].resolvers[0].positionId']);
  });

  it('refuses a named approver who is not a live employee with a login', async () => {
    knownUsers = [];
    const result = await run(() =>
      build().create({
        requestType: 'leave.request',
        companyId: COMPANY,
        name: 'X',
        steps: [{ ...validStep, resolvers: [{ type: 'specific_user', userId: UUID }] }],
      }),
    );

    expect(!result.ok && fieldsOf(result.error)).toEqual(['steps[0].resolvers[0].userId']);
  });

  it('checks a fallback resolver’s reference too', async () => {
    roleExists = false;
    const result = await run(() =>
      build().create({
        requestType: 'leave.request',
        companyId: COMPANY,
        name: 'X',
        steps: [
          {
            ...validStep,
            onVacancy: {
              policy: 'fallback_resolver',
              resolver: { type: 'role_holders', roleId: UUID },
            },
          },
        ],
      }),
    );

    expect(!result.ok && fieldsOf(result.error)).toEqual(['steps[0].onVacancy.resolver.roleId']);
  });

  it('refuses to deactivate the last catch-all while conditional siblings remain', async () => {
    chains = [
      chain({ id: 'default' }),
      chain({ id: 'strict', conditions: [{ field: 'dayCount', op: 'gt', value: 5 }] }),
    ];

    const result = await run(() => build().update('default', { isActive: false }));

    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(updated).toEqual([]);
  });

  it('allows removing the last chain of a type entirely', async () => {
    // Nothing left means `APRV_NO_CHAIN_CONFIGURED` at submit, which is loud.
    // A conditional set with no catch-all is the silent version, and only that
    // one is refused.
    chains = [chain({ id: 'default' })];

    const result = await run(() => build().archive('default'));

    expect(result.ok).toBe(true);
    expect(archived).toEqual(['default']);
  });

  it('allows deactivating a conditional chain', async () => {
    chains = [
      chain({ id: 'default' }),
      chain({ id: 'strict', conditions: [{ field: 'dayCount', op: 'gt', value: 5 }] }),
    ];

    const result = await run(() => build().update('strict', { isActive: false }));

    expect(result.ok).toBe(true);
    expect(updated[0]?.patch).toEqual({ isActive: false });
  });

  it('never patches the request type — the conditions are bound to it', async () => {
    chains = [chain({ id: 'c-1' })];

    await run(() => build().update('c-1', { requestType: 'expense.claim', name: 'Renamed' }));

    expect(updated[0]?.patch).toEqual({ name: 'Renamed' });
  });
});
