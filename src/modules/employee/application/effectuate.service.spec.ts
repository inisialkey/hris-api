import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import type { AccountLifecyclePort } from '../../auth';
import type {
  EmployeeOutboxPort,
  EmployeeRepositoryPort,
  StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { EmployeeRow, StatusHistoryRow } from '../domain/employee.types';
import { EffectuateService } from './effectuate.service';

/**
 * UC-EMP-007 and BR-EMP-006. Two properties carry this service and both are
 * about *not* doing something twice: the claim is atomic, and the exit effects
 * only run for a terminal status.
 */
describe('EffectuateService (UC-EMP-007)', () => {
  const NOW = new Date('2026-08-06T02:00:00Z');

  let claimed: boolean;
  let statusWrites: { id: string; status: string }[];
  let closed: { employeeId: string; date: string }[];
  let deactivated: string[];
  let emitted: { name: string; payload: Record<string, unknown> }[];
  let closeResult: Result<void>;
  let dueRows: StatusHistoryRow[];
  let employee: EmployeeRow | null;

  const row = (over: Partial<StatusHistoryRow> = {}): StatusHistoryRow => ({
    id: 'h-1',
    employeeId: 'e-1',
    status: 'terminated',
    source: 'termination',
    sourceId: null,
    effectiveDate: '2026-08-06',
    reason: null,
    appliedAt: null,
    ...over,
  });

  beforeEach(() => {
    claimed = true;
    statusWrites = [];
    closed = [];
    deactivated = [];
    emitted = [];
    closeResult = ok(undefined);
    dueRows = [];
    employee = {
      id: 'e-1',
      companyId: 'co-1',
      userId: 'u-1',
      status: 'active',
    } as EmployeeRow;
  });

  function build() {
    const employees = {
      findById: () => Promise.resolve(employee),
      setStatus: (id: string, status: string) => {
        statusWrites.push({ id, status });
        return Promise.resolve();
      },
    } as unknown as EmployeeRepositoryPort;

    const history = {
      due: () => Promise.resolve(dueRows),
      markApplied: () => Promise.resolve(claimed),
    } as unknown as StatusHistoryRepositoryPort;

    const placement = {
      assignOnHire: () => Promise.resolve(ok(undefined)),
      closeOnExit: (employeeId: string, date: string) => {
        closed.push({ employeeId, date });
        return Promise.resolve(closeResult);
      },
    };

    const accounts: AccountLifecyclePort = {
      createUserForEmployee: () => Promise.resolve(ok({ userId: 'u' })),
      deactivateUser: (userId) => {
        deactivated.push(userId);
        return Promise.resolve();
      },
    };

    const outbox: EmployeeOutboxPort = {
      emit: (event) => {
        emitted.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    return new EffectuateService(employees, history, placement, accounts, outbox, {
      now: () => NOW,
    });
  }

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({ requestId: 'r-1' });
      return fn();
    });
  }

  it('applies a terminal transition and runs the whole BR-EMP-006 effect set', async () => {
    const applied = await inTenant(() => build().apply(row()));

    expect(applied).toBe(true);
    expect(statusWrites).toEqual([{ id: 'e-1', status: 'terminated' }]);
    expect(closed).toEqual([{ employeeId: 'e-1', date: '2026-08-06' }]);
    expect(deactivated).toEqual(['u-1']);
    expect(emitted).toEqual([
      {
        name: 'employee.status.changed',
        payload: {
          employeeId: 'e-1',
          companyId: 'co-1',
          status: 'terminated',
          effectiveDate: '2026-08-06',
          source: 'termination',
        },
      },
    ]);
  });

  it('does nothing at all when the claim was lost — the idempotency of UC-EMP-007', async () => {
    // A second runner reaching the same row after the first committed. The
    // guard is `applied_at IS NULL` in the UPDATE, so the loser sees no row.
    claimed = false;
    const applied = await inTenant(() => build().apply(row()));

    expect(applied).toBe(false);
    expect(statusWrites).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('claims before the effects, so a crashed run cannot double-emit', async () => {
    // The event is the one non-idempotent effect: a second emit is a second
    // eventId, and every consumer's dedup guard is keyed on that.
    const order: string[] = [];
    const employees = {
      findById: () => {
        order.push('read');
        return Promise.resolve(employee);
      },
      setStatus: () => {
        order.push('status');
        return Promise.resolve();
      },
    } as unknown as EmployeeRepositoryPort;
    const history = {
      markApplied: () => {
        order.push('claim');
        return Promise.resolve(true);
      },
    } as unknown as StatusHistoryRepositoryPort;

    await inTenant(() =>
      new EffectuateService(
        employees,
        history,
        {
          assignOnHire: () => Promise.resolve(ok(undefined)),
          closeOnExit: () => Promise.resolve(ok(undefined)),
        },
        {
          createUserForEmployee: () => Promise.resolve(ok({ userId: 'u' })),
          deactivateUser: () => Promise.resolve(),
        },
        {
          emit: () => {
            order.push('emit');
            return Promise.resolve();
          },
        },
        { now: () => NOW },
      ).apply(row()),
    );

    expect(order[0]).toBe('claim');
    expect(order.indexOf('emit')).toBeGreaterThan(order.indexOf('claim'));
  });

  it('runs no exit effects for a non-terminal transition', async () => {
    // `active → on_leave` is a status change, not an exit: the assignment stays
    // open and the login stays alive.
    await inTenant(() => build().apply(row({ status: 'on_leave', source: 'leave' })));

    expect(statusWrites).toEqual([{ id: 'e-1', status: 'on_leave' }]);
    expect(closed).toEqual([]);
    expect(deactivated).toEqual([]);
  });

  it('deactivates nothing when the employee never had a login', async () => {
    employee = { ...(employee as EmployeeRow), userId: null };
    await inTenant(() => build().apply(row()));

    expect(deactivated).toEqual([]);
    expect(closed).toHaveLength(1);
  });

  it('throws rather than half-applying when the placement refuses', async () => {
    // A locked period. Rolling back leaves the schedule unclaimed for the next
    // run; committing would leave an exited employee still holding a seat.
    closeResult = fail({ code: 'ORG_PERIOD_LOCKED', messageKey: 'errors.ORG_PERIOD_LOCKED' });

    await expect(inTenant(() => build().apply(row()))).rejects.toThrow(/ORG_PERIOD_LOCKED/);
    expect(emitted).toEqual([]);
  });

  it('walks the due set in the order the repository gave it', async () => {
    dueRows = [
      row({ id: 'h-1', status: 'on_leave', source: 'leave', effectiveDate: '2026-08-01' }),
      row({ id: 'h-2', status: 'resigned', source: 'resignation', effectiveDate: '2026-08-05' }),
    ];

    const applied = await inTenant(() => build().runDue('2026-08-06'));

    expect(applied).toBe(2);
    // Newest-first would leave the status reading `on_leave` after the person
    // had gone.
    expect(statusWrites.map((w) => w.status)).toEqual(['on_leave', 'resigned']);
  });

  it('skips a scheduled row whose employee no longer exists', async () => {
    employee = null;
    const applied = await inTenant(() => build().apply(row()));

    expect(applied).toBe(false);
    expect(emitted).toEqual([]);
  });
});
