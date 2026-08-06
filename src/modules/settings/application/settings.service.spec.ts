import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { SettingScope, SettingValueRow } from '../domain/setting.types';
import { SettingsService } from './settings.service';

/** UC-SET-001's two paths: the cached now, and the uncached past. */
describe('SettingsService', () => {
  const NOW = new Date('2026-08-06T03:00:00Z');

  let rows: SettingValueRow[];
  let cached: Record<string, unknown> | null;
  let writes: Record<string, unknown>[];
  let liveQueries: number;
  let keyQueries: number;

  function row(over: Partial<SettingValueRow>): SettingValueRow {
    return {
      id: 'v1',
      key: 'notification.retention_days',
      level: 'tenant',
      companyId: null,
      branchId: null,
      value: 30,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      ...over,
    };
  }

  function build(): SettingsService {
    const repository = {
      listLiveForScope: () => {
        liveQueries += 1;
        return Promise.resolve(rows);
      },
      listForKey: () => {
        keyQueries += 1;
        return Promise.resolve(rows);
      },
      listForKeyAtScope: () => Promise.resolve(rows),
      findById: () => Promise.resolve(null),
      listHistory: () => Promise.resolve({ rows: [], total: 0 }),
      applyWrite: () => Promise.reject(new Error('not used')),
      applyCancel: () => Promise.reject(new Error('not used')),
    };

    const cache = {
      read: () => Promise.resolve(cached),
      write: (_tenantId: string, _scope: SettingScope, values: Record<string, unknown>) => {
        writes.push(values);
        return Promise.resolve();
      },
      bust: () => Promise.resolve(),
    };

    return new SettingsService(repository, cache, { now: () => NOW });
  }

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, async () => {
      setTenantContext({ tenantId: 't1', source: 'jwt' });
      return fn();
    });
  }

  beforeEach(() => {
    rows = [];
    cached = null;
    writes = [];
    liveQueries = 0;
    keyQueries = 0;
  });

  it('falls back to the definition default with nothing set', async () => {
    const value = await inTenant(() => build().resolve<number>('notification.retention_days'));
    expect(value).toBe(90);
  });

  it('returns the tenant value when one exists', async () => {
    rows = [row({})];
    expect(await inTenant(() => build().resolve<number>('notification.retention_days'))).toBe(30);
  });

  it('resolves every key on one miss, not the one asked for', async () => {
    // The cache unit is a map (§4.1) and the chain query costs the same either
    // way, so a request reading five keys pays one round trip — which is also
    // what makes BR-SET-009's one-snapshot-per-request true by construction.
    const service = build();
    await inTenant(async () => {
      await service.resolve('notification.retention_days');
    });

    expect(liveQueries).toBe(1);
    expect(Object.keys(writes[0] ?? {}).length).toBeGreaterThan(30);
    expect(writes[0]).toMatchObject({
      'notification.retention_days': 90,
      'inbox.retention_days': 180,
    });
  });

  it('serves a cache hit without touching the database', async () => {
    cached = { 'notification.retention_days': 7 };
    const value = await inTenant(() => build().resolve<number>('notification.retention_days'));
    expect(value).toBe(7);
    expect(liveQueries).toBe(0);
  });

  it('falls back to the default for a key the cached map predates', async () => {
    // The release that adds a key ships while maps cached by the previous one
    // are still live. Reading straight out of the map would hand every caller
    // `undefined` for that key until the TTL expired — on every deploy.
    cached = { 'inbox.retention_days': 200 };
    expect(await inTenant(() => build().resolve<number>('notification.retention_days'))).toBe(90);
  });

  it('does the same for the client map', async () => {
    cached = { 'inbox.retention_days': 200 };
    const visible = await inTenant(() => build().resolveClientVisible({}));
    expect(visible['attendance.geofence_radius_m']).toBe(100);
  });

  it('bypasses the cache for an as-of-past read', async () => {
    // BR-SET-004 / ADR-0012: re-running May must see May's value, and a cache
    // keyed by scope alone cannot express a date.
    cached = { 'notification.retention_days': 7 };
    rows = [
      row({ id: 'h', value: 60, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' }),
      row({ id: 'live', value: 30, effectiveFrom: '2026-06-01' }),
    ];

    const value = await inTenant(() =>
      build().resolve<number>('notification.retention_days', {}, '2026-05-15'),
    );

    expect(value).toBe(60);
    expect(keyQueries).toBe(1);
    expect(liveQueries).toBe(0);
  });

  it('treats an as-of of today as the cached path', async () => {
    cached = { 'notification.retention_days': 7 };
    expect(
      await inTenant(() =>
        build().resolve<number>('notification.retention_days', {}, '2026-08-06'),
      ),
    ).toBe(7);
    expect(keyQueries).toBe(0);
  });

  it('throws on an unregistered key rather than returning a default', async () => {
    // UC-SET-001: a key not in the registry is a typo in the caller, and a
    // silent default would let it ship.
    await expect(inTenant(() => build().resolve('notification.made_up'))).rejects.toThrow(
      /unknown setting key/,
    );
  });

  it('ships only clientVisible keys, and never an auth one', async () => {
    // BR-SET-007. `/settings/effective` is reachable by any authenticated
    // caller, and token lifetimes are exactly what an attacker would like.
    const visible = await inTenant(() => build().resolveClientVisible({}));
    const keys = Object.keys(visible);

    expect(keys).toContain('attendance.geofence_radius_m');
    expect(keys.some((key) => key.startsWith('auth.'))).toBe(false);
    expect(keys).not.toContain('notification.retention_days');
  });
});
