import { randomBytes } from 'node:crypto';

import type { CompanyScope } from '../../../shared/context';
import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { blindIndex } from '../../../shared/crypto/encrypted-text';
import type { OrgQueryPort } from '../../organization';
import type {
  ContractRepositoryPort,
  EmployeeRepositoryPort,
  FamilyRepositoryPort,
  StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { EmployeeRow, EmployeeStatus } from '../domain/employee.types';
import { EmployeeService } from './employee.service';

describe('EmployeeService', () => {
  const indexKey = randomBytes(32);

  let stored: EmployeeRow;
  let nikClashId: string | null;
  let deleted: string[];
  let updates: { id: string; patch: Record<string, unknown> }[];
  let contractBatchCalls: number;

  beforeEach(() => {
    stored = {
      id: 'e-1',
      companyId: 'co-1',
      userId: null,
      employeeNumber: 'EMP-00001',
      fullName: 'Sari',
      joinDate: '2026-01-01',
      employmentType: 'pkwtt',
      status: 'active',
      nik: '3201234567890001',
      npwp: null,
      bpjsKesehatanNumber: null,
      bpjsKetenagakerjaanNumber: null,
      bankName: null,
      bankAccountNumber: null,
      bankAccountHolder: null,
      birthPlace: null,
      birthDate: '1990-01-01',
      gender: 'female',
      maritalStatus: 'single',
      religion: null,
      ptkpStatus: 'tk_0',
      address: null,
      phone: null,
      personalEmail: null,
      updatedAt: new Date('2026-08-06T00:00:00Z'),
    };
    nikClashId = null;
    deleted = [];
    updates = [];
    contractBatchCalls = 0;
  });

  function build() {
    const employees = {
      list: () => Promise.resolve({ rows: [stored, { ...stored, id: 'e-2' }], total: 2 }),
      findById: (id: string) => Promise.resolve(id === stored.id ? stored : null),
      findLiveByNikBidx: () => Promise.resolve(nikClashId ? { id: nikClashId } : null),
      findLiveByNpwpBidx: () => Promise.resolve(nikClashId ? { id: nikClashId } : null),
      update: (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, patch });
        return Promise.resolve({ ...stored, ...patch });
      },
      softDelete: (id: string) => {
        deleted.push(id);
        return Promise.resolve(true);
      },
    } as unknown as EmployeeRepositoryPort;

    const contracts = {
      currentAt: () => Promise.resolve(null),
      currentAtBatch: () => {
        contractBatchCalls += 1;
        return Promise.resolve(new Map());
      },
    } as unknown as ContractRepositoryPort;

    const family = { listFor: () => Promise.resolve([]) } as unknown as FamilyRepositoryPort;
    const history = {
      listFor: () => Promise.resolve([]),
    } as unknown as StatusHistoryRepositoryPort;
    const org = {
      placement: () => Promise.resolve(null),
      placements: () => Promise.resolve(new Map()),
    } as unknown as OrgQueryPort;

    const keys = { indexKey: () => Promise.resolve(indexKey) };

    return new EmployeeService(employees, contracts, family, history, org, keys as never);
  }

  function asCaller<T>(fn: () => Promise<T>, companyScope: CompanyScope = 'all'): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      setRequestContext({
        requestId: 'r-1',
        userId: 'u-1',
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set<string>(), companyScope }),
        },
      });
      return fn();
    });
  }

  describe('list', () => {
    it('resolves contract end dates in one query for the page, not one per row', async () => {
      // A repository call inside a `for` over rows is a review blocker
      // (coding-standards-nestjs §5).
      await asCaller(() => build().list({}, { limit: 20, offset: 0 }, '2026-08-06'));
      expect(contractBatchCalls).toBe(1);
    });
  });

  describe('archive (BR-EMP-013)', () => {
    it.each(['active', 'on_leave'] as EmployeeStatus[])(
      'refuses to delete a %s employee',
      async (status) => {
        stored = { ...stored, status };
        const result = await asCaller(() => build().archive('e-1'));

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('EMP_STILL_ACTIVE');
        // Deleting outright would leave a live org assignment and a live login.
        expect(deleted).toEqual([]);
      },
    );

    it.each(['resigned', 'terminated'] as EmployeeStatus[])(
      'soft-deletes a %s employee, freeing the NIK for a rehire',
      async (status) => {
        stored = { ...stored, status };
        expect((await asCaller(() => build().archive('e-1'))).ok).toBe(true);
        expect(deleted).toEqual(['e-1']);
      },
    );
  });

  describe('scope', () => {
    it('404s a company-scoped admin reaching outside their scope', async () => {
      const result = await asCaller(() => build().detail('e-1', '2026-08-06'), ['co-other']);

      expect(result.ok).toBe(false);
      // Not 403: telling them the employee exists is the disclosure the scope
      // was drawn to prevent.
      if (!result.ok) expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('lets a company-scoped admin read inside their scope', async () => {
      expect((await asCaller(() => build().detail('e-1', '2026-08-06'), ['co-1'])).ok).toBe(true);
    });
  });

  describe('update (UC-EMP-002)', () => {
    it('refuses a NIK already held by another live employee', async () => {
      nikClashId = 'e-other';
      const result = await asCaller(() => build().update('e-1', { nik: '3201234567890002' }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
      expect(updates).toEqual([]);
    });

    it('accepts a NIK whose only holder is the row being edited', async () => {
      // Self-exclusion: re-saving an unchanged NIK must not collide with itself.
      nikClashId = null;
      expect((await asCaller(() => build().update('e-1', { nik: '3201234567890001' }))).ok).toBe(
        true,
      );
    });

    it('skips the duplicate check entirely when neither identifier is touched', async () => {
      nikClashId = 'e-other';
      const result = await asCaller(() => build().update('e-1', { phone: '+628111' }));

      expect(result.ok).toBe(true);
      expect(updates).toEqual([{ id: 'e-1', patch: { phone: '+628111' } }]);
    });

    it('passes the blind index to the check, never the NIK', async () => {
      const seen: string[] = [];
      const employees = {
        findById: () => Promise.resolve(stored),
        findLiveByNikBidx: (bidx: string) => {
          seen.push(bidx);
          return Promise.resolve(null);
        },
        update: () => Promise.resolve(stored),
      } as unknown as EmployeeRepositoryPort;

      await asCaller(() =>
        new EmployeeService(
          employees,
          { currentAt: () => Promise.resolve(null) } as unknown as ContractRepositoryPort,
          { listFor: () => Promise.resolve([]) } as unknown as FamilyRepositoryPort,
          { listFor: () => Promise.resolve([]) } as unknown as StatusHistoryRepositoryPort,
          {} as unknown as OrgQueryPort,
          { indexKey: () => Promise.resolve(indexKey) } as never,
        ).update('e-1', { nik: '3201234567890099' }),
      );

      expect(seen).toEqual([blindIndex(indexKey, '3201234567890099')]);
    });
  });
});
