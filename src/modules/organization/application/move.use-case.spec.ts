import {
  runInContextScope,
  setRequestContext,
  setTenantContext,
  type ResolvedAuthorization,
} from '../../../shared/context';
import type { LockedDate, PeriodLockPort } from '../../../shared/period-lock.port';
import type {
  AssignmentRepositoryPort,
  BranchRepositoryPort,
  EmployeeLookupPort,
  OrganizationOutboxPort,
  PlacementCachePort,
  PositionRepositoryPort,
} from '../domain/organization.ports';
import type { AssignmentRow, MoveRequest } from '../domain/organization.types';
import { MoveUseCase } from './move.use-case';

/**
 * UC-ORG-003 and UC-ORG-004 — the check order is the rule set, so each test
 * disables exactly one guard and asserts the code the module contracts for.
 */
describe('MoveUseCase', () => {
  const TODAY = '2026-08-06';
  const NOW = new Date(`${TODAY}T03:00:00Z`);

  let history: AssignmentRow[];
  let lock: LockedDate | null;
  let employeeCompany: string;
  let positionCompany: string;
  let branchCompany: string;
  let superseded: { close: unknown; insert: unknown }[];
  let cancelled: unknown[];
  let events: { name: string; payload: Record<string, unknown> }[];
  let busts: string[];
  let supersedeThrows: Error | undefined;

  function request(over: Partial<MoveRequest> = {}): MoveRequest {
    return {
      positionId: 'pos-new',
      branchId: 'br-new',
      kind: 'transfer',
      effectiveFrom: '2026-09-01',
      ...over,
    };
  }

  function build(): MoveUseCase {
    const assignments = {
      liveHistory: () => Promise.resolve(history),
      findById: (id: string) => Promise.resolve(history.find((row) => row.id === id) ?? null),
      supersede: (_employeeId: string, plan: { close: unknown; insert: unknown }) => {
        if (supersedeThrows) throw supersedeThrows;
        superseded.push(plan);
        return Promise.resolve({
          id: 'new-row',
          employeeId: 'e-1',
          positionId: 'pos-new',
          branchId: 'br-new',
          kind: 'transfer' as const,
          note: null,
          effectiveFrom: '2026-09-01',
          effectiveTo: null,
        });
      },
      cancel: (plan: unknown) => {
        cancelled.push(plan);
        return Promise.resolve();
      },
      closeLiveAt: () => Promise.resolve(true),
    } as unknown as AssignmentRepositoryPort;

    const positions = {
      findById: () => Promise.resolve({ id: 'pos-new', companyId: positionCompany }),
    } as unknown as PositionRepositoryPort;

    const branches = {
      findById: () => Promise.resolve({ id: 'br-new', companyId: branchCompany }),
    } as unknown as BranchRepositoryPort;

    const employees: EmployeeLookupPort = {
      find: () =>
        Promise.resolve({ id: 'e-1', companyId: employeeCompany, joinDate: '2026-01-01' }),
      findByUserId: () => Promise.resolve({ id: 'e-1', companyId: employeeCompany }),
    };

    const periods: PeriodLockPort = {
      isLocked: () => Promise.resolve(lock !== null),
      firstLockedDate: () => Promise.resolve(lock),
    };

    const cache: PlacementCachePort = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      bust: (_tenantId, employeeId) => {
        busts.push(employeeId);
        return Promise.resolve();
      },
    };

    const outbox: OrganizationOutboxPort = {
      emit: (event) => {
        events.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    return new MoveUseCase(assignments, positions, branches, employees, periods, cache, outbox, {
      now: () => NOW,
    });
  }

  function asAdmin<T>(fn: () => Promise<T>, companyScope: 'all' | string[] = 'all'): Promise<T> {
    const authorization: ResolvedAuthorization = {
      permissions: new Set(['organization.assignment.assign']),
      companyScope,
    };
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't1', source: 'jwt' });
      setRequestContext({
        requestId: 'r1',
        userId: 'u-1',
        authorization: { resolve: () => Promise.resolve(authorization) },
      });
      return fn();
    });
  }

  beforeEach(() => {
    history = [
      {
        id: 'a',
        employeeId: 'e-1',
        positionId: 'pos-old',
        branchId: 'br-old',
        kind: 'hire',
        note: null,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
    ];
    lock = null;
    employeeCompany = 'co-1';
    positionCompany = 'co-1';
    branchCompany = 'co-1';
    superseded = [];
    cancelled = [];
    events = [];
    busts = [];
    supersedeThrows = undefined;
  });

  describe('move', () => {
    it('supersedes, busts the cache and announces the change', async () => {
      const result = await asAdmin(() => build().move('e-1', request()));

      expect(result.ok).toBe(true);
      expect(superseded[0]?.close).toEqual({ id: 'a', effectiveTo: '2026-09-01' });
      expect(busts).toEqual(['e-1']);
      expect(events[0]).toEqual({
        name: 'organization.assignment.changed',
        payload: {
          employeeId: 'e-1',
          positionId: 'pos-new',
          branchId: 'br-new',
          effectiveFrom: '2026-09-01',
        },
      });
    });

    it('refuses a position in another company (BR-ORG-002)', async () => {
      positionCompany = 'co-2';

      const result = await asAdmin(() => build().move('e-1', request()));

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('ORG_CROSS_COMPANY');
      expect(superseded).toEqual([]);
    });

    it('refuses a branch in another company', async () => {
      branchCompany = 'co-2';

      const result = await asAdmin(() => build().move('e-1', request()));

      expect(!result.ok && result.error.code).toBe('ORG_CROSS_COMPANY');
    });

    it('refuses a date inside a locked period (BR-ORG-008)', async () => {
      lock = { date: '2026-03-01', periodId: 'per-1', label: 'March 2026' };

      const result = await asAdmin(() => build().move('e-1', request()));

      expect(!result.ok && result.error.code).toBe('ORG_PERIOD_LOCKED');
      expect(!result.ok && result.error.details).toEqual({ periodId: 'per-1' });
      expect(superseded).toEqual([]);
    });

    it('passes when the port says the period is open', async () => {
      const result = await asAdmin(() => build().move('e-1', request()));
      expect(result.ok).toBe(true);
    });

    it('hides an employee outside the caller’s company scope behind a 404', async () => {
      const result = await asAdmin(() => build().move('e-1', request()), ['co-9']);

      expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('turns the exclusion violation into ORG_ASSIGNMENT_OVERLAP', async () => {
      // The race the constraint exists for: two admins moving one employee in the
      // same instant, so the planner's read is already stale when it commits.
      supersedeThrows = Object.assign(new Error('conflict'), {
        code: '23P01',
        constraint: 'excl_org_assignments_no_overlap',
      });

      const result = await asAdmin(() => build().move('e-1', request()));

      expect(!result.ok && result.error.code).toBe('ORG_ASSIGNMENT_OVERLAP');
    });

    it('rethrows a database error it does not recognise', async () => {
      supersedeThrows = Object.assign(new Error('boom'), { code: '08006' });

      await expect(asAdmin(() => build().move('e-1', request()))).rejects.toThrow('boom');
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      history = [
        {
          id: 'a',
          employeeId: 'e-1',
          positionId: 'pos-old',
          branchId: 'br-old',
          kind: 'hire',
          note: null,
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-09-01',
        },
        {
          id: 'b',
          employeeId: 'e-1',
          positionId: 'pos-new',
          branchId: 'br-new',
          kind: 'transfer',
          note: null,
          effectiveFrom: '2026-09-01',
          effectiveTo: null,
        },
      ];
    });

    it('cancels a scheduled move and reopens its predecessor', async () => {
      const result = await asAdmin(() => build().cancel('e-1', 'b'));

      expect(result.ok).toBe(true);
      expect(cancelled[0]).toEqual({
        softDelete: 'b',
        reopen: { id: 'a', effectiveTo: null },
      });
      expect(busts).toEqual(['e-1']);
    });

    it('refuses to cancel a row already in effect', async () => {
      const result = await asAdmin(() => build().cancel('e-1', 'a'));

      expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
      expect(cancelled).toEqual([]);
    });

    it('refuses a locked period', async () => {
      lock = { date: '2026-03-01', periodId: 'per-1', label: 'March 2026' };

      const result = await asAdmin(() => build().cancel('e-1', 'b'));

      expect(!result.ok && result.error.code).toBe('ORG_PERIOD_LOCKED');
    });

    it('404s an assignment belonging to another employee', async () => {
      history = history.map((row) => ({ ...row, employeeId: 'e-2' }));

      const result = await asAdmin(() => build().cancel('e-1', 'b'));

      expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    });
  });

  describe('assignOnHire (BR-ORG-002)', () => {
    it('seeds the first placement with kind hire', async () => {
      history = [];

      const result = await asAdmin(() =>
        build().assignOnHire('e-1', 'pos-new', 'br-new', '2026-01-01'),
      );

      expect(result.ok).toBe(true);
      expect(superseded[0]).toMatchObject({
        close: null,
        insert: { kind: 'hire', effectiveFrom: '2026-01-01' },
      });
    });

    it('still refuses a cross-company seat', async () => {
      history = [];
      positionCompany = 'co-2';

      const result = await asAdmin(() =>
        build().assignOnHire('e-1', 'pos-new', 'br-new', '2026-01-01'),
      );

      expect(!result.ok && result.error.code).toBe('ORG_CROSS_COMPANY');
    });
  });
});
