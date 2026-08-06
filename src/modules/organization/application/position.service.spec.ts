import {
  runInContextScope,
  setRequestContext,
  setTenantContext,
  type CompanyScope,
} from '../../../shared/context';
import type {
  DepartmentRepositoryPort,
  EmployeeLookupPort,
  JobLevelRepositoryPort,
  PositionRepositoryPort,
} from '../domain/organization.ports';
import type { ChartNode } from '../domain/organization.types';
import { PositionService } from './position.service';

/**
 * UC-ORG-006's scoping, which §7 states in five words — *"admins: any in scope.
 * Others: forced own"* — and which is the difference between an org chart every
 * employee can open and one only HR can.
 */
describe('PositionService.chart', () => {
  const NOW = new Date('2026-08-06T03:00:00Z');

  let charted: string[];

  function node(over: Partial<ChartNode> & { positionId: string }): ChartNode {
    return {
      code: over.positionId,
      title: over.positionId,
      departmentId: 'dep-1',
      departmentName: 'Finance',
      jobLevelId: 'lvl-1',
      rank: 1,
      reportsToPositionId: null,
      holders: [],
      vacant: true,
      ...over,
    };
  }

  /** CFO → MGR → { ANL-1, ANL-2 } */
  const NODES: ChartNode[] = [
    node({ positionId: 'CFO' }),
    node({ positionId: 'MGR', reportsToPositionId: 'CFO' }),
    node({ positionId: 'ANL-1', reportsToPositionId: 'MGR' }),
    node({ positionId: 'ANL-2', reportsToPositionId: 'MGR' }),
  ];

  function build(ownCompanyId: string | null = 'co-own'): PositionService {
    const positions = {
      chart: (companyId: string) => {
        charted.push(companyId);
        return Promise.resolve(NODES);
      },
    } as unknown as PositionRepositoryPort;

    const employees: EmployeeLookupPort = {
      find: () => Promise.resolve(null),
      findByUserId: () =>
        Promise.resolve(ownCompanyId ? { id: 'e-1', companyId: ownCompanyId } : null),
    };

    return new PositionService(
      positions,
      {} as unknown as DepartmentRepositoryPort,
      {} as unknown as JobLevelRepositoryPort,
      employees,
      { now: () => NOW },
    );
  }

  function asCaller<T>(fn: () => Promise<T>, companyScope: CompanyScope): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't1', source: 'jwt' });
      setRequestContext({
        requestId: 'r1',
        userId: 'u-1',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope }),
        },
      });
      return fn();
    });
  }

  beforeEach(() => {
    charted = [];
  });

  it('forces an employee with no assignment to their own company', async () => {
    // The ordinary caller: no `user_roles` row at all, so `companyScope` is
    // empty. Reading the scope would 404 the majority of this endpoint's users.
    const result = await asCaller(() => build().chart({}), []);

    expect(result.ok).toBe(true);
    expect(charted).toEqual(['co-own']);
  });

  it('ignores a company an employee asks for that is not theirs', async () => {
    await asCaller(() => build().chart({ companyId: 'co-other' }), []);

    expect(charted).toEqual(['co-own']);
  });

  it('404s an employee with no employee record at all', async () => {
    const result = await asCaller(() => build(null).chart({}), []);

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('lets a company-scoped admin pick a company inside their scope', async () => {
    const result = await asCaller(() => build().chart({ companyId: 'co-2' }), ['co-1', 'co-2']);

    expect(result.ok).toBe(true);
    expect(charted).toEqual(['co-2']);
  });

  it('404s a company-scoped admin reaching outside their scope', async () => {
    const result = await asCaller(() => build().chart({ companyId: 'co-9' }), ['co-1']);

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    expect(charted).toEqual([]);
  });

  it('falls an admin back to the one company they hold', async () => {
    await asCaller(() => build().chart({}), ['co-1']);

    expect(charted).toEqual(['co-1']);
  });

  it('404s a tenant-wide admin who names no company', async () => {
    // Tenant-wide means every company, so there is no "own" to fall back to —
    // the scope bar has to say which one.
    const result = await asCaller(() => build().chart({}), 'all');

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  describe('subtree slicing', () => {
    it('returns the whole forest with no root', async () => {
      const result = await asCaller(() => build().chart({}), ['co-1']);

      expect(result.ok && result.value.map((n) => n.positionId)).toEqual([
        'CFO',
        'MGR',
        'ANL-1',
        'ANL-2',
      ]);
    });

    it('returns a subtree from rootPositionId', async () => {
      const result = await asCaller(() => build().chart({ rootPositionId: 'MGR' }), ['co-1']);

      expect(result.ok && result.value.map((n) => n.positionId)).toEqual(['MGR', 'ANL-1', 'ANL-2']);
    });

    it('cuts the subtree at depth', async () => {
      const result = await asCaller(
        () => build().chart({ rootPositionId: 'CFO', depth: 2 }),
        ['co-1'],
      );

      expect(result.ok && result.value.map((n) => n.positionId)).toEqual(['CFO', 'MGR']);
    });

    it('returns nothing for a root that is not in the chart', async () => {
      const result = await asCaller(() => build().chart({ rootPositionId: 'gone' }), ['co-1']);

      expect(result.ok && result.value).toEqual([]);
    });
  });
});
