import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { ApprovalDirectoryPort, DelegationRepositoryPort } from '../domain/approval.ports';
import type { DelegationRow } from '../domain/approval.types';
import { DelegationService } from './delegation.service';

/** UC-APRV-006 — the service half; the overlap rule itself is tested in `resolution.spec`. */
describe('DelegationService (UC-APRV-006)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let existing: DelegationRow[];
  let knownUsers: string[];
  let calls: string[];
  let revoked: string[];

  const row = (over: Partial<DelegationRow> = {}): DelegationRow => ({
    id: 'd-1',
    delegatorUserId: 'u-1',
    delegateUserId: 'u-2',
    requestTypes: null,
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    revokedAt: null,
    ...over,
  });

  beforeEach(() => {
    existing = [];
    knownUsers = ['u-1', 'u-2'];
    calls = [];
    revoked = [];
  });

  function build(): DelegationService {
    const repository = {
      lockDelegator: () => {
        calls.push('lock');
        return Promise.resolve();
      },
      listForDelegator: () => {
        calls.push('read');
        return Promise.resolve(existing);
      },
      create: (values: Record<string, unknown>) => {
        calls.push('create');
        return Promise.resolve(row(values as Partial<DelegationRow>));
      },
      findById: (id: string) => Promise.resolve(existing.find((entry) => entry.id === id) ?? null),
      revoke: (id: string) => {
        revoked.push(id);
        return Promise.resolve(true);
      },
    } as unknown as DelegationRepositoryPort;

    const directory = {
      byUserIds: (ids: readonly string[]) =>
        Promise.resolve(new Map(ids.filter((id) => knownUsers.includes(id)).map((id) => [id, {}]))),
    } as unknown as ApprovalDirectoryPort;

    return new DelegationService(repository, directory, { now: () => NOW });
  }

  const create = (over: Partial<Parameters<DelegationService['create']>[0]> = {}) =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      return build().create({
        delegatorUserId: 'u-1',
        delegateUserId: 'u-2',
        startDate: '2026-03-01',
        endDate: '2026-03-31',
        ...over,
      });
    });

  it('creates a delegation and takes the lock before reading', async () => {
    const result = await create();

    expect(result.ok).toBe(true);
    // The pre-check reads rows that do not exist yet; reading first would let two
    // admins both see no conflict.
    expect(calls).toEqual(['lock', 'read', 'create']);
  });

  it('refuses a delegation to yourself', async () => {
    const result = await create({ delegateUserId: 'u-1' });

    expect(!result.ok && result.error.code).toBe('APRV_SELF_DELEGATION');
    expect(calls).toEqual([]);
  });

  it('refuses an inverted date pair', async () => {
    const result = await create({ startDate: '2026-03-31', endDate: '2026-03-01' });
    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('refuses a request type outside §13’s registry', async () => {
    const result = await create({ requestTypes: ['invented.thing'] });
    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('answers 404 for a user the directory does not carry', async () => {
    knownUsers = ['u-1'];
    const result = await create();
    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('reports the conflicting row on an overlap', async () => {
    existing = [row({ id: 'd-existing' })];

    const result = await create({ startDate: '2026-03-15', endDate: '2026-04-15' });

    expect(!result.ok && result.error.code).toBe('APRV_DELEGATION_OVERLAP');
    expect(!result.ok && result.error.details).toEqual({ conflictingDelegationId: 'd-existing' });
  });

  it('hides somebody else’s delegation from an unprivileged revoke', async () => {
    existing = [row({ id: 'd-1', delegatorUserId: 'u-other' })];

    const result = await runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      return build().revoke('d-1', 'u-1', false);
    });

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    expect(revoked).toEqual([]);
  });

  it('lets the key holder revoke it', async () => {
    existing = [row({ id: 'd-1', delegatorUserId: 'u-other' })];

    const result = await runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      return build().revoke('d-1', 'u-1', true);
    });

    expect(result.ok).toBe(true);
    expect(revoked).toEqual(['d-1']);
  });

  it('is idempotent on an already-revoked row', async () => {
    existing = [row({ id: 'd-1', revokedAt: NOW })];

    const result = await runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      return build().revoke('d-1', 'u-1', false);
    });

    expect(result.ok).toBe(true);
    expect(revoked).toEqual([]);
  });
});
