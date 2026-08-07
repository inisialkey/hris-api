import { randomBytes } from 'node:crypto';

import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { blindIndex } from '../../../shared/crypto/encrypted-text';
import { fail, ok, type Result } from '../../../shared/result';
import type { AccountLifecyclePort } from '../../auth';
import type {
  ContractRepositoryPort,
  EmployeeNumberCounterPort,
  EmployeeRepositoryPort,
  NewStatusHistory,
  StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { EmployeeCreateInput, EmployeeRow, StatusHistoryRow } from '../domain/employee.types';
import { HireUseCase } from './hire.use-case';

/**
 * UC-EMP-001 / BR-EMP-002. The property under test throughout is **atomicity of
 * intent**: every step happens, in the order the rule states, and a refusal
 * anywhere returns before the next step runs.
 */
describe('HireUseCase (UC-EMP-001)', () => {
  const indexKey = randomBytes(32);
  const NOW = new Date('2026-08-06T02:00:00Z');

  let created: EmployeeCreateInput | null;
  let contracts: unknown[];
  let histories: NewStatusHistory[];
  let placements: unknown[];
  let accountCalls: string[];
  let linkedUser: string | null;
  let nikClash: boolean;
  let npwpClash: boolean;
  let placementResult: Result<void>;
  let accountResult: Result<{ userId: string }>;
  let counterCalls: number;

  const input: EmployeeCreateInput = {
    companyId: 'co-1',
    fullName: 'Sari Dewi',
    nik: '3201234567890001',
    birthDate: '1990-05-04',
    gender: 'female',
    maritalStatus: 'single',
    ptkpStatus: 'tk_0',
    joinDate: '2026-08-01',
    employmentType: 'pkwtt',
    positionId: 'pos-1',
    branchId: 'br-1',
  };

  beforeEach(() => {
    created = null;
    contracts = [];
    histories = [];
    placements = [];
    accountCalls = [];
    linkedUser = null;
    nikClash = false;
    npwpClash = false;
    placementResult = ok(undefined);
    accountResult = ok({ userId: 'u-new' });
    counterCalls = 0;
  });

  const employees: EmployeeRepositoryPort = {
    list: () => Promise.resolve({ rows: [], total: 0 }),
    findById: () => Promise.resolve(null),
    findByUserId: () => Promise.resolve(null),
    findLiveByNikBidx: () => Promise.resolve(nikClash ? { id: 'other' } : null),
    findLiveByNpwpBidx: () => Promise.resolve(npwpClash ? { id: 'other' } : null),
    create: (values, employeeNumber) => {
      created = values;
      return Promise.resolve({
        ...(values as unknown as EmployeeRow),
        id: 'e-new',
        employeeNumber,
        userId: null,
        status: 'active',
        updatedAt: NOW,
      } as EmployeeRow);
    },
    update: () => Promise.resolve(null),
    linkUser: (_id, userId) => {
      linkedUser = userId;
      return Promise.resolve();
    },
    setStatus: () => Promise.resolve(),
    setEmploymentType: () => Promise.resolve(),
    softDelete: () => Promise.resolve(true),
  };

  const contractRepo = {
    create: (values: unknown) => {
      contracts.push(values);
      return Promise.resolve(values as never);
    },
  } as unknown as ContractRepositoryPort;

  const history = {
    insert: (row: NewStatusHistory) => {
      histories.push(row);
      return Promise.resolve({ ...row, id: 'h-1' } as unknown as StatusHistoryRow);
    },
  } as unknown as StatusHistoryRepositoryPort;

  const counter: EmployeeNumberCounterPort = {
    next: () => {
      counterCalls += 1;
      return Promise.resolve('EMP-00001');
    },
  };

  const placementPort = {
    assignOnHire: (employeeId: string, positionId: string, branchId: string, from: string) => {
      placements.push({ employeeId, positionId, branchId, from });
      return Promise.resolve(placementResult);
    },
    closeOnExit: () => Promise.resolve(ok(undefined)),
  };

  const accounts: AccountLifecyclePort = {
    createUserForEmployee: (_id: string, email: string) => {
      accountCalls.push(email);
      return Promise.resolve(accountResult);
    },
    deactivateUser: () => Promise.resolve(),
  };

  const keys = {
    ensureLoaded: () => Promise.resolve(),
    indexKey: () => Promise.resolve(indexKey),
  };

  function build() {
    return new HireUseCase(
      employees,
      contractRepo,
      history,
      counter,
      placementPort,
      accounts,
      keys as never,
      { now: () => NOW },
    );
  }

  function run(overrides: Partial<EmployeeCreateInput> = {}) {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'req-1',
        userId: 'u-admin',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope: 'all' }),
        },
      });
      return build().execute({ ...input, ...overrides });
    });
  }

  it('writes the row, the contract, the hire history and the placement', async () => {
    const result = await run();

    expect(result.ok).toBe(true);
    expect(created).toMatchObject({ fullName: 'Sari Dewi', nik: '3201234567890001' });
    expect(contracts).toEqual([
      {
        employeeId: 'e-new',
        kind: 'pkwtt',
        startDate: '2026-08-01',
        endDate: null,
        fileId: null,
        note: null,
      },
    ]);
    expect(placements).toEqual([
      { employeeId: 'e-new', positionId: 'pos-1', branchId: 'br-1', from: '2026-08-01' },
    ]);
  });

  it('stamps the hire history applied, so the effectuate job never re-runs it', async () => {
    await run();
    expect(histories).toEqual([
      {
        employeeId: 'e-new',
        status: 'active',
        source: 'hire',
        effectiveDate: '2026-08-01',
        appliedAt: NOW,
      },
    ]);
  });

  it('refuses a NIK already live in the tenant, naming the field (BR-EMP-001)', async () => {
    nikClash = true;
    const result = await run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    // Nothing was written — the check runs before the counter is touched, so a
    // rejected hire does not burn an employee number.
    expect(created).toBeNull();
    expect(counterCalls).toBe(0);
  });

  it('refuses a duplicate NPWP only when one was supplied', async () => {
    npwpClash = true;
    expect((await run()).ok).toBe(true); // no npwp on the input at all
    expect((await run({ npwp: '098765432109000' })).ok).toBe(false);
  });

  it('checks the blind index, never the plaintext', async () => {
    const seen: string[] = [];
    const spy: EmployeeRepositoryPort = {
      ...employees,
      findLiveByNikBidx: (bidx: string) => {
        seen.push(bidx);
        return Promise.resolve(null);
      },
    };
    await runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'r',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope: 'all' }),
        },
      });
      return new HireUseCase(
        spy,
        contractRepo,
        history,
        counter,
        placementPort,
        accounts,
        keys as never,
        { now: () => NOW },
      ).execute(input);
    });

    expect(seen).toEqual([blindIndex(indexKey, input.nik)]);
    expect(seen[0]).not.toContain(input.nik);
  });

  it('refuses a PKWT with no end date before writing anything (BR-EMP-007)', async () => {
    const result = await run({ employmentType: 'pkwt', contractEndDate: null });

    expect(result.ok).toBe(false);
    expect(created).toBeNull();
    // The DB CHECK would also refuse it, as `SYS_INTERNAL`. §8 asks for a field
    // entry, and `EmployeeHirePort`'s callers never pass through a DTO.
    if (!result.ok) expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('carries the ORG_ code out unchanged when placement refuses', async () => {
    placementResult = fail({
      code: 'ORG_PERIOD_LOCKED',
      messageKey: 'errors.ORG_PERIOD_LOCKED',
    });
    const result = await run();

    expect(result.ok).toBe(false);
    // organization owns the rule that was violated, so it owns the code the
    // client branches on (§5).
    if (!result.ok) expect(result.error.code).toBe('ORG_PERIOD_LOCKED');
  });

  it('creates and links the account when one was asked for', async () => {
    const result = await run({ createAccount: { email: 'sari@tenant.test' } });

    expect(accountCalls).toEqual(['sari@tenant.test']);
    expect(linkedUser).toBe('u-new');
    if (result.ok) expect(result.value.userId).toBe('u-new');
  });

  it('creates no account when none was asked for', async () => {
    await run();
    expect(accountCalls).toEqual([]);
    expect(linkedUser).toBeNull();
  });

  it('surfaces an account failure rather than leaving a half-provisioned hire', async () => {
    accountResult = fail({ code: 'VAL_VALIDATION_FAILED', messageKey: 'x' });
    const result = await run({ createAccount: { email: 'taken@tenant.test' } });

    expect(result.ok).toBe(false);
    expect(linkedUser).toBeNull();
  });

  it('honours a provided employee number instead of burning a counter value', async () => {
    await run({ employeeNumber: 'LEGACY-7' });
    expect(counterCalls).toBe(0);
  });

  it('takes a number from the counter when none was provided (BR-EMP-012)', async () => {
    const result = await run();
    expect(counterCalls).toBe(1);
    if (result.ok) expect(result.value.employeeNumber).toBe('EMP-00001');
  });
});
