import {
  runInContextScope,
  setRequestContext,
  setTenantContext,
  type CompanyScope,
} from '../../../shared/context';
import type {
  BranchRepositoryPort,
  CompanyRepositoryPort,
  DepartmentRepositoryPort,
  JobLevelRepositoryPort,
  OrganizationOutboxPort,
} from '../domain/organization.ports';
import type { ArchiveBlocker, BranchRow, DepartmentRow } from '../domain/organization.types';
import { BranchService } from './branch.service';
import { CompanyService } from './company.service';
import { DepartmentService } from './department.service';
import { JobLevelService } from './job-level.service';

/**
 * The structure rules §14 names that are not database constraints: the cycle and
 * depth checks, the archive guards with their counts, the timezone event, and
 * the tenant-wide assignment that separates a company-scoped admin from one who
 * may mint a company or a grade band.
 */
describe('structure services', () => {
  let events: { name: string; payload: Record<string, unknown> }[];

  function inScope<T>(fn: () => Promise<T>, companyScope: CompanyScope = 'all'): Promise<T> {
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
    events = [];
  });

  const outbox: OrganizationOutboxPort = {
    emit: (event) => {
      events.push({ name: event.name, payload: event.payload });
      return Promise.resolve();
    },
  };

  describe('departments (BR-ORG-004)', () => {
    /** d1 → d2 → d3 → d4 → d5 → d6, plus a two-node branch b1 → b2 under d1. */
    const TREE: DepartmentRow[] = [
      { id: 'd1', companyId: 'co-1', parentDepartmentId: null, code: 'D1', name: 'One' },
      { id: 'd2', companyId: 'co-1', parentDepartmentId: 'd1', code: 'D2', name: 'Two' },
      { id: 'd3', companyId: 'co-1', parentDepartmentId: 'd2', code: 'D3', name: 'Three' },
      { id: 'd4', companyId: 'co-1', parentDepartmentId: 'd3', code: 'D4', name: 'Four' },
      { id: 'd5', companyId: 'co-1', parentDepartmentId: 'd4', code: 'D5', name: 'Five' },
      { id: 'd6', companyId: 'co-1', parentDepartmentId: 'd5', code: 'D6', name: 'Six' },
      { id: 'b1', companyId: 'co-1', parentDepartmentId: 'd1', code: 'B1', name: 'Branch one' },
      { id: 'b2', companyId: 'co-1', parentDepartmentId: 'b1', code: 'B2', name: 'Branch two' },
    ];

    let blockers: ArchiveBlocker[];
    let updates: { id: string; patch: Record<string, unknown> }[];

    function build(): DepartmentService {
      const departments = {
        listAll: () => Promise.resolve(TREE),
        findById: (id: string) => Promise.resolve(TREE.find((row) => row.id === id) ?? null),
        findByCode: () => Promise.resolve(null),
        create: (values: Omit<DepartmentRow, 'id'>) => Promise.resolve({ id: 'new', ...values }),
        update: (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return Promise.resolve({ ...TREE[0], id } as DepartmentRow);
        },
        archive: () => Promise.resolve(true),
        archiveBlockers: () => Promise.resolve(blockers),
      } as unknown as DepartmentRepositoryPort;

      return new DepartmentService(departments);
    }

    beforeEach(() => {
      blockers = [];
      updates = [];
    });

    it('refuses a department that would become its own ancestor', async () => {
      const result = await inScope(() => build().update('d2', { parentDepartmentId: 'd5' }));

      expect(!result.ok && result.error.code).toBe('ORG_CYCLE_DETECTED');
      expect(updates).toEqual([]);
    });

    it('refuses a self-parent', async () => {
      const result = await inScope(() => build().update('d3', { parentDepartmentId: 'd3' }));

      expect(!result.ok && result.error.code).toBe('ORG_CYCLE_DETECTED');
    });

    it('refuses a re-parent that pushes the subtree past depth six', async () => {
      // b1 is two levels tall: under d5 its leaf lands at 7.
      const result = await inScope(() => build().update('b1', { parentDepartmentId: 'd5' }));

      expect(!result.ok && result.error.code).toBe('ORG_CYCLE_DETECTED');
    });

    it('allows the same subtree one level higher', async () => {
      const result = await inScope(() => build().update('b1', { parentDepartmentId: 'd4' }));

      expect(result.ok).toBe(true);
      expect(updates[0]).toEqual({ id: 'b1', patch: { parentDepartmentId: 'd4' } });
    });

    it('renames without touching the graph', async () => {
      const result = await inScope(() => build().update('d6', { name: 'Renamed' }));

      expect(result.ok).toBe(true);
      expect(updates[0]).toEqual({ id: 'd6', patch: { name: 'Renamed' } });
    });

    it('lists archive blockers with their counts rather than a bare refusal', async () => {
      blockers = [
        { type: 'position', count: 3 },
        { type: 'child_department', count: 1 },
      ];

      const result = await inScope(() => build().archive('d6'));

      expect(!result.ok && result.error.code).toBe('ORG_IN_USE');
      expect(!result.ok && result.error.details).toEqual({ blockers });
    });

    it('archives a clean department', async () => {
      const result = await inScope(() => build().archive('d6'));
      expect(result.ok).toBe(true);
    });
  });

  describe('branches (BR-ORG-007)', () => {
    const EXISTING: BranchRow = {
      id: 'br-1',
      companyId: 'co-1',
      code: 'JKT',
      name: 'Jakarta',
      timezone: 'Asia/Jakarta',
      address: null,
      latitude: null,
      longitude: null,
    };

    function build(): BranchService {
      const branches = {
        findById: () => Promise.resolve(EXISTING),
        update: (_id: string, patch: Partial<BranchRow>) =>
          Promise.resolve({ ...EXISTING, ...patch }),
        archiveBlockers: () => Promise.resolve([]),
        archive: () => Promise.resolve(true),
      } as unknown as BranchRepositoryPort;

      return new BranchService(branches, outbox);
    }

    it('emits organization.branch.updated when the timezone moves', async () => {
      const result = await inScope(() => build().update('br-1', { timezone: 'Asia/Makassar' }));

      expect(result.ok).toBe(true);
      expect(events).toEqual([
        {
          name: 'organization.branch.updated',
          payload: { branchId: 'br-1', changedFields: ['timezone'] },
        },
      ]);
    });

    it('does not name the timezone on a rename', async () => {
      // Attendance recomputes future dates when it sees `timezone` in
      // `changedFields` — a rename that woke that job would be a recompute for
      // nothing.
      await inScope(() => build().update('br-1', { name: 'Jakarta Pusat' }));

      expect(events[0]?.payload).toEqual({ branchId: 'br-1', changedFields: ['name'] });
    });

    it('stays silent when nothing actually changed', async () => {
      await inScope(() => build().update('br-1', { timezone: 'Asia/Jakarta' }));

      expect(events).toEqual([]);
    });

    it('refuses half a geofence centre with a field entry, not a 500', async () => {
      // The CHECK says the same thing, but a constraint violation surfaces as
      // SYS_INTERNAL and §8 asks for a field the form can point at.
      const result = await inScope(() => build().update('br-1', { latitude: '-6.2' }));

      expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
      expect(events).toEqual([]);
    });

    it('accepts one coordinate when the row already carries the other', async () => {
      const withLongitude = new BranchService(
        {
          findById: () => Promise.resolve({ ...EXISTING, longitude: '106.8' }),
          update: (_id: string, patch: Partial<BranchRow>) =>
            Promise.resolve({ ...EXISTING, ...patch }),
        } as unknown as BranchRepositoryPort,
        outbox,
      );

      const result = await inScope(() => withLongitude.update('br-1', { latitude: '-6.2' }));

      expect(result.ok).toBe(true);
    });
  });

  describe('tenant-wide objects (§2)', () => {
    function jobLevels(): JobLevelService {
      const repository = {
        findByCode: () => Promise.resolve(null),
        create: (values: Record<string, unknown>) => Promise.resolve({ id: 'new', ...values }),
      } as unknown as JobLevelRepositoryPort;
      return new JobLevelService(repository);
    }

    function companies(existingCode: boolean): CompanyService {
      const repository = {
        findByCode: () => Promise.resolve(existingCode ? { id: 'co-1', code: 'HO' } : null),
        create: (values: Record<string, unknown>) => Promise.resolve({ id: 'new', ...values }),
      } as unknown as CompanyRepositoryPort;
      return new CompanyService(repository);
    }

    it('refuses a company-scoped admin creating a grade band', async () => {
      const result = await inScope(
        () => jobLevels().create({ code: 'L3', name: 'Manager', rank: 3 }),
        ['co-1'],
      );

      expect(!result.ok && result.error.code).toBe('AUTHZ_PERMISSION_DENIED');
    });

    it('lets a tenant-wide admin create one', async () => {
      const result = await inScope(() =>
        jobLevels().create({ code: 'L3', name: 'Manager', rank: 3 }),
      );

      expect(result.ok).toBe(true);
    });

    it('refuses a company-scoped admin creating a company', async () => {
      const result = await inScope(() => companies(false).create(newCompany()), ['co-1']);

      expect(!result.ok && result.error.code).toBe('AUTHZ_PERMISSION_DENIED');
    });

    it('reports a duplicate code as a field entry', async () => {
      const result = await inScope(() => companies(true).create(newCompany()));

      expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
    });
  });
});

function newCompany() {
  return {
    code: 'HO',
    name: 'Head Office',
    legalName: null,
    npwp: null,
    address: null,
    phone: null,
  };
}
