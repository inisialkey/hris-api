import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type {
  EmployeeRepositoryPort,
  NewStatusHistory,
  StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { EmployeeRow, EmployeeStatus, StatusHistoryRow } from '../domain/employee.types';
import type { EffectuateService } from './effectuate.service';
import { TerminateUseCase } from './terminate.use-case';

describe('TerminateUseCase (UC-EMP-006)', () => {
  const NOW = new Date('2026-08-06T02:00:00Z');

  let stored: EmployeeRow;
  let pendingTerminal: StatusHistoryRow | null;
  let inserted: NewStatusHistory[];
  let appliedRows: string[];

  beforeEach(() => {
    stored = {
      id: 'e-1',
      companyId: 'co-1',
      status: 'active',
      joinDate: '2026-01-01',
    } as EmployeeRow;
    pendingTerminal = null;
    inserted = [];
    appliedRows = [];
  });

  function build() {
    const employees = {
      findById: (id: string) => Promise.resolve(id === 'e-1' ? stored : null),
    } as unknown as EmployeeRepositoryPort;

    const history = {
      pendingTerminalFor: () => Promise.resolve(pendingTerminal),
      insert: (row: NewStatusHistory) => {
        inserted.push(row);
        return Promise.resolve({ ...row, id: 'h-new' } as unknown as StatusHistoryRow);
      },
    } as unknown as StatusHistoryRepositoryPort;

    const effectuate = {
      apply: (row: StatusHistoryRow) => {
        appliedRows.push(row.id);
        return Promise.resolve(true);
      },
    } as unknown as EffectuateService;

    return new TerminateUseCase(employees, history, effectuate, { now: () => NOW });
  }

  function run(input: { effectiveDate: string; reason: string }) {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'r-1',
        userId: 'u-1',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope: 'all' }),
        },
      });
      return build().execute('e-1', input);
    });
  }

  it('effectuates inline when the date is today', async () => {
    // An admin who just decided should not wait a day for the decision to land.
    const result = await run({ effectiveDate: '2026-08-06', reason: 'restructuring' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ applied: true, status: 'terminated' });
    expect(appliedRows).toEqual(['h-new']);
  });

  it('only schedules when the date is in the future', async () => {
    const result = await run({ effectiveDate: '2026-09-01', reason: 'notice period' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ applied: false, status: 'active' });
    // The row exists; the status has not moved and the login is still alive.
    expect(inserted).toHaveLength(1);
    expect(appliedRows).toEqual([]);
  });

  it.each(['resigned', 'terminated'] as EmployeeStatus[])(
    'refuses to terminate a %s employee',
    async (status) => {
      stored = { ...stored, status };
      const result = await run({ effectiveDate: '2026-08-06', reason: 'x' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EMP_STATUS_TRANSITION_INVALID');
      expect(inserted).toEqual([]);
    },
  );

  it('refuses a second terminal schedule (§9)', async () => {
    // A scheduled resignation and a scheduled termination would both
    // effectuate, and the second would transition out of a terminal state.
    pendingTerminal = { id: 'h-old', status: 'resigned' } as StatusHistoryRow;
    const result = await run({ effectiveDate: '2026-09-01', reason: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('EMP_STATUS_TRANSITION_INVALID');
  });

  it('refuses a backdated effective date', async () => {
    const result = await run({ effectiveDate: '2026-08-05', reason: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(inserted).toEqual([]);
  });

  it('refuses an effective date before the join date', async () => {
    stored = { ...stored, joinDate: '2026-12-01' };
    const result = await run({ effectiveDate: '2026-08-06', reason: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('terminates an on_leave employee — leave is not protection from an exit', async () => {
    stored = { ...stored, status: 'on_leave' };
    expect((await run({ effectiveDate: '2026-08-06', reason: 'x' })).ok).toBe(true);
  });
});
