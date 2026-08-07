import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { ContractRepositoryPort, EmployeeRepositoryPort } from '../domain/employee.ports';
import type { ContractRow, EmployeeRow } from '../domain/employee.types';
import { ContractService } from './contract.service';

describe('ContractService (UC-EMP-008, BR-EMP-007)', () => {
  const NOW = new Date('2026-08-06T02:00:00Z');

  let rows: ContractRow[];
  let currentToday: ContractRow | null;
  let typeWrites: { id: string; kind: string }[];
  let created: unknown[];
  let deleted: string[];
  let throwOnWrite: Error | null;

  const contract = (over: Partial<ContractRow> = {}): ContractRow => ({
    id: 'c-1',
    employeeId: 'e-1',
    kind: 'pkwt',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    fileId: null,
    note: null,
    lastRemindedDays: null,
    createdBy: null,
    ...over,
  });

  beforeEach(() => {
    rows = [contract()];
    currentToday = contract();
    typeWrites = [];
    created = [];
    deleted = [];
    throwOnWrite = null;
  });

  function build() {
    const contracts = {
      listFor: () => Promise.resolve(rows),
      findById: (id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
      currentAt: () => Promise.resolve(currentToday),
      create: (values: unknown) => {
        if (throwOnWrite) throw throwOnWrite;
        created.push(values);
        return Promise.resolve(contract({ id: 'c-new' }));
      },
      update: (id: string, patch: Partial<ContractRow>) =>
        Promise.resolve(contract({ ...patch, id })),
      softDelete: (id: string) => {
        deleted.push(id);
        return Promise.resolve(true);
      },
      countFor: () => Promise.resolve(rows.length),
    } as unknown as ContractRepositoryPort;

    const employees = {
      findById: () => Promise.resolve({ id: 'e-1', companyId: 'co-1' } as EmployeeRow),
      setEmploymentType: (id: string, kind: string) => {
        typeWrites.push({ id, kind });
        return Promise.resolve();
      },
    } as unknown as EmployeeRepositoryPort;

    return new ContractService(contracts, employees, { now: () => NOW });
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'r-1',
        userId: 'u-1',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope: 'all' }),
        },
      });
      return fn();
    });
  }

  it('refuses a PKWT with no end date', async () => {
    const result = await run(() =>
      build().create('e-1', { kind: 'pkwt', startDate: '2027-01-01' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(created).toEqual([]);
  });

  it('drops an end date supplied for a PKWTT rather than letting the CHECK refuse it', async () => {
    // `kind = 'pkwtt' AND end_date IS NULL` is the constraint; a value here
    // would surface as SYS_INTERNAL where §8 asks for nothing at all.
    await run(() =>
      build().create('e-1', { kind: 'pkwtt', startDate: '2027-01-01', endDate: '2028-01-01' }),
    );

    expect(created).toEqual([
      {
        employeeId: 'e-1',
        kind: 'pkwtt',
        startDate: '2027-01-01',
        endDate: null,
        fileId: null,
        note: null,
      },
    ]);
  });

  it('maps the exclusion constraint to EMP_CONTRACT_OVERLAP', async () => {
    // Two admins renewing one employee in the same instant. No pre-check could
    // win that race, which is what the constraint is for.
    throwOnWrite = Object.assign(new Error('conflict'), {
      code: '23P01',
      constraint: 'excl_employee_contracts_no_overlap',
    });

    const result = await run(() =>
      build().create('e-1', { kind: 'pkwt', startDate: '2026-06-01', endDate: '2026-11-30' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMP_CONTRACT_OVERLAP');
  });

  it('mirrors employment_type onto the contract current today, not the one just written', async () => {
    // A future-dated PKWTT renewal must not flip today's type.
    currentToday = contract({ kind: 'pkwt' });
    await run(() => build().create('e-1', { kind: 'pkwtt', startDate: '2027-01-01' }));

    expect(typeWrites).toEqual([{ id: 'e-1', kind: 'pkwt' }]);
  });

  it('refuses to delete the last remaining contract row', async () => {
    // An employee always has a contract (BR-EMP-002 writes one at hire), so a
    // row set that can empty makes `employment_type` a value with no source.
    rows = [contract()];
    const result = await run(() => build().archive('e-1', 'c-1'));

    expect(result.ok).toBe(false);
    expect(deleted).toEqual([]);
  });

  it('deletes a row when another remains', async () => {
    rows = [contract(), contract({ id: 'c-2', startDate: '2027-01-01', endDate: '2027-12-31' })];
    expect((await run(() => build().archive('e-1', 'c-2'))).ok).toBe(true);
    expect(deleted).toEqual(['c-2']);
  });

  it('404s a contract id belonging to a different employee', async () => {
    const result = await run(() => build().archive('e-1', 'c-elsewhere'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
  });
});
