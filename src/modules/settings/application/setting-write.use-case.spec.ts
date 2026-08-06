import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { CancelPlan, WritePlan } from '../domain/plan-write';
import type { SettingValueRow } from '../domain/setting.types';
import type { ExactScope } from '../domain/settings.ports';
import { SettingWriteUseCase, type SettingActor } from './setting-write.use-case';

/** The write path's own decisions: authority, scope, then the plan. */
describe('SettingWriteUseCase', () => {
  const TODAY = '2026-08-06';

  let rows: SettingValueRow[];
  let applied: { key: string; scope: ExactScope; plan: WritePlan }[];
  let cancelled: CancelPlan[];
  let events: Record<string, unknown>[];
  let busts: number;
  let permissions: Set<string>;
  let companies: 'all' | readonly string[];
  let permissionChecks: number;

  function row(over: Partial<SettingValueRow>): SettingValueRow {
    return {
      id: 'v1',
      key: 'notification.retention_days',
      level: 'tenant',
      companyId: null,
      branchId: null,
      value: 90,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      ...over,
    };
  }

  function actor(): SettingActor {
    return {
      has: (permission: string) => {
        permissionChecks += 1;
        return Promise.resolve(permissions.has(permission));
      },
      companyScope: () => Promise.resolve(companies),
    };
  }

  function build(): SettingWriteUseCase {
    const repository = {
      listLiveForScope: () => Promise.resolve(rows),
      listForKey: () => Promise.resolve(rows),
      listForKeyAtScope: () => Promise.resolve(rows),
      findById: (id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
      listHistory: () => Promise.resolve({ rows: [], total: 0 }),
      applyWrite: (key: string, scope: ExactScope, plan: WritePlan) => {
        applied.push({ key, scope, plan });
        return Promise.resolve(row({ id: 'new', value: plan.insert.value }));
      },
      applyCancel: (plan: CancelPlan) => {
        cancelled.push(plan);
        return Promise.resolve();
      },
    };

    const cache = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      bust: () => {
        busts += 1;
        return Promise.resolve();
      },
    };

    const outbox = {
      emit: (event: { payload: Record<string, unknown> }) => {
        events.push(event.payload);
        return Promise.resolve();
      },
    };

    return new SettingWriteUseCase(repository, cache, outbox);
  }

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, async () => {
      setTenantContext({ tenantId: 't1', source: 'jwt' });
      return fn();
    });
  }

  beforeEach(() => {
    rows = [];
    applied = [];
    cancelled = [];
    events = [];
    busts = 0;
    permissions = new Set(['settings.setting.configure']);
    companies = 'all';
    permissionChecks = 0;
  });

  it('writes a tenant value, busts the cache and emits the fact', async () => {
    const result = await inTenant(() =>
      build().write(
        actor(),
        { key: 'notification.retention_days', level: 'tenant', value: 30 },
        TODAY,
      ),
    );

    expect(result.ok).toBe(true);
    expect(applied).toHaveLength(1);
    expect(busts).toBe(1);
    expect(events).toEqual([
      {
        action: 'set',
        key: 'notification.retention_days',
        level: 'tenant',
        companyId: undefined,
        branchId: undefined,
        effectiveFrom: TODAY,
        value: 30,
      },
    ]);
  });

  it('refuses an unregistered key as a field error, not a 404', async () => {
    // BR-SET-001: the client sent a bad `key`, and §8 puts the complaint on that
    // field so the editor can point at it.
    const result = await inTenant(() =>
      build().write(actor(), { key: 'notification.made_up', level: 'tenant', value: 1 }, TODAY),
    );

    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    const entries = result.error.details?.__fieldEntries as { field: string; code: string }[];
    expect(entries).toEqual([expect.objectContaining({ field: 'key', code: 'VAL_INVALID_ENUM' })]);
    expect(applied).toEqual([]);
  });

  it('demands the definition override on a high-stakes key', async () => {
    // §2: an HR Admin configures settings and does not configure `tax.method`.
    const result = await inTenant(() =>
      build().write(actor(), { key: 'tax.method', level: 'tenant', value: 'gross_up' }, TODAY),
    );

    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('AUTHZ_PERMISSION_DENIED');
    expect(result.error.details).toEqual({ permission: 'settings.statutory_policy.configure' });
  });

  it('accepts the same key once the override is held', async () => {
    permissions.add('settings.statutory_policy.configure');
    const result = await inTenant(() =>
      build().write(actor(), { key: 'tax.method', level: 'tenant', value: 'gross_up' }, TODAY),
    );
    expect(result.ok).toBe(true);
  });

  it('never resolves a permission for a key with no override', async () => {
    // ADR-0005's lazy rule: the ordinary key was already checked by the guard,
    // and re-resolving here would make every settings write pay for it twice.
    await inTenant(() =>
      build().write(
        actor(),
        { key: 'notification.retention_days', level: 'tenant', value: 30 },
        TODAY,
      ),
    );
    expect(permissionChecks).toBe(0);
  });

  it('hides a company outside the caller’s scope behind a 404', async () => {
    companies = ['c1'];
    const result = await inTenant(() =>
      build().write(
        actor(),
        { key: 'document.expiry_reminder_days', level: 'company', companyId: 'c2', value: 15 },
        TODAY,
      ),
    );

    if (result.ok) throw new Error('unreachable');
    // Not 403: a 403 confirms the company exists (error-catalog §2).
    expect(result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('requires the company id the level implies', async () => {
    const result = await inTenant(() =>
      build().write(
        actor(),
        { key: 'document.expiry_reminder_days', level: 'company', value: 15 },
        TODAY,
      ),
    );

    if (result.ok) throw new Error('unreachable');
    const entries = result.error.details?.__fieldEntries as { field: string }[];
    expect(entries?.[0]?.field).toBe('companyId');
  });

  it('validates the value against its definition before touching a row', async () => {
    const result = await inTenant(() =>
      build().write(actor(), { key: 'auth.password_min_length', level: 'tenant', value: 8 }, TODAY),
    );

    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(applied).toEqual([]);
    // A refused write leaves the cache alone — busting it would be a free
    // stampede on every rejected keystroke in the editor.
    expect(busts).toBe(0);
  });

  it('emits `scheduled` for a future date on a dated key', async () => {
    permissions.add('settings.statutory_policy.configure');
    await inTenant(() =>
      build().write(
        actor(),
        { key: 'tax.method', level: 'tenant', value: 'gross_up', effectiveFrom: '2027-01-01' },
        TODAY,
      ),
    );
    expect(events[0]).toMatchObject({ action: 'scheduled', effectiveFrom: '2027-01-01' });
  });

  describe('cancel', () => {
    it('deletes the scheduled row and carries the dead value in the event', async () => {
      // UC-SET-004: the delete is hard, so without the value on the event the
      // cancellation would leave audit nothing to record.
      rows = [
        row({ id: 'live', value: 90, effectiveTo: '2027-01-01' }),
        row({ id: 'future', value: 30, effectiveFrom: '2027-01-01' }),
      ];

      const result = await inTenant(() => build().cancel('future', TODAY));

      expect(result.ok).toBe(true);
      expect(cancelled).toEqual([{ delete: 'future', reopen: 'live' }]);
      expect(events[0]).toMatchObject({
        action: 'cancelled',
        value: 30,
        effectiveFrom: '2027-01-01',
      });
      expect(busts).toBe(1);
    });

    it('answers 404 for a row that is not there', async () => {
      const result = await inTenant(() => build().cancel('missing', TODAY));
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('refuses to cancel a live row', async () => {
      rows = [row({ id: 'live' })];
      const result = await inTenant(() => build().cancel('live', TODAY));
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('SET_HISTORY_IMMUTABLE');
      expect(cancelled).toEqual([]);
    });
  });
});
