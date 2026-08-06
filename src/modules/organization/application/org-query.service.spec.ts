import { runInContextScope, setTenantContext } from '../../../shared/context';
import type {
  AssignmentRepositoryPort,
  DepartmentRepositoryPort,
  PlacementCachePort,
  PositionRepositoryPort,
} from '../domain/organization.ports';
import type { Placement, PositionRow } from '../domain/organization.types';
import { OrgQueryService } from './org-query.service';

/**
 * UC-ORG-001 and UC-ORG-002 — the two reads eleven module documents depend on.
 *
 * The reporting chain under test:
 *   FIN-STAFF → FIN-MGR → CFO → (top)
 */
describe('OrgQueryService', () => {
  const TODAY = '2026-08-06';
  const NOW = new Date(`${TODAY}T03:00:00Z`);

  let holderCalls: { positionIds: string[]; exclude?: string }[];
  let holders: Record<string, string[]>;
  let placementFor: Placement | null;
  let cacheReads: number;
  let cacheWrites: Placement[];
  let placementQueries: number;

  function position(over: Partial<PositionRow> & { id: string }): PositionRow {
    return {
      companyId: 'co-1',
      departmentId: 'dep-1',
      jobLevelId: 'lvl-1',
      code: over.id,
      title: over.id,
      reportsToPositionId: null,
      ...over,
    };
  }

  const CHART: PositionRow[] = [
    position({ id: 'FIN-STAFF', reportsToPositionId: 'FIN-MGR' }),
    position({ id: 'FIN-MGR', reportsToPositionId: 'CFO' }),
    position({ id: 'CFO' }),
  ];

  function build(): OrgQueryService {
    const assignments = {
      placement: () => {
        placementQueries += 1;
        return Promise.resolve(placementFor);
      },
      placements: (ids: string[]) =>
        Promise.resolve(new Map(placementFor ? [[ids[0] ?? '', placementFor]] : [])),
      holderUserIds: (positionIds: string[], _asOf: string, exclude?: string) => {
        holderCalls.push({ positionIds, exclude });
        return Promise.resolve(positionIds.flatMap((id) => holders[id] ?? []));
      },
      audienceEmployeeIds: (rules: { departmentIds?: string[] }) =>
        Promise.resolve(rules.departmentIds ?? ['everyone']),
    } as unknown as AssignmentRepositoryPort;

    const positions = {
      listAll: () => Promise.resolve(CHART),
    } as unknown as PositionRepositoryPort;

    const departments = {
      descendantIds: (ids: string[]) => Promise.resolve([...ids, `${ids[0] ?? ''}-child`]),
    } as unknown as DepartmentRepositoryPort;

    const cache: PlacementCachePort = {
      read: () => {
        cacheReads += 1;
        return Promise.resolve(null);
      },
      write: (_tenantId, _employeeId, placement) => {
        cacheWrites.push(placement);
        return Promise.resolve();
      },
      bust: () => Promise.resolve(),
    };

    return new OrgQueryService(assignments, positions, departments, cache, { now: () => NOW });
  }

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't1', source: 'jwt' });
      return fn();
    });
  }

  beforeEach(() => {
    holderCalls = [];
    holders = { 'FIN-MGR': ['u-mgr'], CFO: ['u-cfo'] };
    placementFor = {
      companyId: 'co-1',
      branchId: 'br-1',
      branchTimezone: 'Asia/Jakarta',
      departmentId: 'dep-1',
      positionId: 'FIN-STAFF',
      jobLevelId: 'lvl-1',
    };
    cacheReads = 0;
    cacheWrites = [];
    placementQueries = 0;
  });

  describe('placement', () => {
    it('caches today and writes the entry back', async () => {
      await inTenant(async () => {
        expect(await build().placement('e-1', TODAY)).toEqual(placementFor);
      });

      expect(cacheReads).toBe(1);
      expect(cacheWrites).toEqual([placementFor]);
    });

    it('skips the cache for a historical as-of read', async () => {
      // The key holds one placement per employee, so a past date would poison it
      // with an answer that is right for a different question.
      await inTenant(() => build().placement('e-1', '2026-01-01'));

      expect(cacheReads).toBe(0);
      expect(cacheWrites).toEqual([]);
      expect(placementQueries).toBe(1);
    });

    it('returns null for an employee with no placement', async () => {
      placementFor = null;
      await inTenant(async () => {
        expect(await build().placement('e-1', TODAY)).toBeNull();
      });
      expect(cacheWrites).toEqual([]);
    });
  });

  describe('directManagers (BR-ORG-003)', () => {
    it('returns the holders one reports-to edge up', async () => {
      await inTenant(async () => {
        expect(await build().directManagers('e-1', 1, TODAY)).toEqual(['u-mgr']);
      });
      expect(holderCalls[0]).toEqual({ positionIds: ['FIN-MGR'], exclude: 'e-1' });
    });

    it('walks exactly n edges for level 2', async () => {
      await inTenant(async () => {
        expect(await build().directManagers('e-1', 2, TODAY)).toEqual(['u-cfo']);
      });
      expect(holderCalls[0]?.positionIds).toEqual(['CFO']);
    });

    it('does not skip a vacant level', async () => {
      // The engine's vacancy ladder decides where to go next (BR-APRV-006).
      // Inventing a fallback here would take that decision from the module that
      // owns it — so an empty level 1 is an empty answer, not the CFO.
      holders = { CFO: ['u-cfo'] };

      await inTenant(async () => {
        expect(await build().directManagers('e-1', 1, TODAY)).toEqual([]);
      });
    });

    it('returns every holder when a position has two', async () => {
      holders = { 'FIN-MGR': ['u-mgr', 'u-co-mgr'] };

      await inTenant(async () => {
        expect(await build().directManagers('e-1', 1, TODAY)).toEqual(['u-mgr', 'u-co-mgr']);
      });
    });

    it('excludes the subject by employee, not by user', async () => {
      // Covers the odd case where the requester also holds the landing position
      // higher up the chain.
      await inTenant(() => build().directManagers('e-1', 2, TODAY));

      expect(holderCalls[0]?.exclude).toBe('e-1');
    });

    it('returns empty when the walk passes the top', async () => {
      await inTenant(async () => {
        expect(await build().directManagers('e-1', 3, TODAY)).toEqual([]);
      });
      expect(holderCalls).toEqual([]);
    });

    it('returns empty for an unplaced employee', async () => {
      placementFor = null;
      await inTenant(async () => {
        expect(await build().directManagers('e-1', 1, TODAY)).toEqual([]);
      });
    });
  });

  describe('audienceEmployeeIds', () => {
    it('descends the department subtree before matching', async () => {
      await inTenant(async () => {
        expect(
          await build().audienceEmployeeIds({ companyId: 'co-1', departmentIds: ['dep-1'] }, TODAY),
        ).toEqual(['dep-1', 'dep-1-child']);
      });
    });

    it('leaves an empty rule set meaning everyone in scope', async () => {
      await inTenant(async () => {
        expect(await build().audienceEmployeeIds({ companyId: 'co-1' }, TODAY)).toEqual([
          'everyone',
        ]);
      });
    });
  });
});
