import { hashToken } from './refresh-token';
import { RefreshUseCase } from './refresh.use-case';
import type { RefreshSuccessor } from './ports/auth-services.port';
import type { DeviceRecord, SessionRecord, UserAccountRecord } from '../domain/auth.ports';

/**
 * UC-AUTH-002 against authentication.md §14: rotation, the grace window, the
 * family revoke, both halves of BR-AUTH-006, and the §7 error ladder. Fakes are
 * structural (no casts) — the compiler reports when a port grows past this file.
 */
describe('RefreshUseCase', () => {
  const NOW = new Date('2026-08-05T09:00:00Z');
  const presented = 'presented-refresh-token';

  let session: SessionRecord | null;
  let user: UserAccountRecord | null;
  let device: DeviceRecord | null;
  let tenantStatus: string;
  let graceStore: Map<string, RefreshSuccessor>;
  let historyStore: Map<string, { sessionId: string; tenantId: string }>;
  let rotatedTo: { hash: string; at: Date }[];
  let revokes: { sessionId: string; reason: string }[];
  let fcmUpdates: string[];
  let events: string[];

  function build(): RefreshUseCase {
    const lookup = {
      findCandidatesByEmail: () => Promise.resolve([]),
      findTenants: () => Promise.resolve([]),
      findSessionByRefreshHash: (hash: string) =>
        Promise.resolve(session && hashToken(presented) === hash ? session : null),
      findAuthTokenByHash: () => Promise.resolve(null),
    };

    const sessions = {
      create: () => Promise.resolve('unused'),
      stampLastLogin: () => Promise.resolve(),
      findById: (id: string) => Promise.resolve(session && session.id === id ? session : null),
      rotate: (_id: string, hash: string, at: Date) => {
        rotatedTo.push({ hash, at });
        return Promise.resolve();
      },
      revoke: (sessionId: string, reason: string) => {
        revokes.push({ sessionId, reason });
        return Promise.resolve(true);
      },
      revokeAllForUser: () => Promise.resolve([]),
      revokeForDevice: () => Promise.resolve([]),
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const devices = {
      findByInstallId: () => Promise.resolve(null),
      findById: () => Promise.resolve(device),
      countActiveForUser: () => Promise.resolve(0),
      create: () => Promise.resolve('unused'),
      touch: () => Promise.resolve(),
      updateFcmToken: (_id: string, token: string) => {
        fcmUpdates.push(token);
        return Promise.resolve();
      },
      revoke: () => Promise.resolve(true),
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const users = {
      findById: () => Promise.resolve(user),
      setPasswordHash: () => Promise.resolve(),
      unlock: () => Promise.resolve(true),
    };

    const tokens = {
      sign: () => Promise.resolve({ token: 'new-access', expiresInSeconds: 900 }),
      verify: () => Promise.resolve(null),
    };

    const tenants = { status: () => Promise.resolve(tenantStatus) };
    const tx = { runInTenant: <T>(_tenantId: string, fn: () => Promise<T>) => fn() };

    const grace = {
      remember: (hash: string, successor: RefreshSuccessor) => {
        graceStore.set(hash, successor);
        return Promise.resolve();
      },
      lookup: (hash: string) => Promise.resolve(graceStore.get(hash) ?? null),
    };

    const history = {
      remember: (hash: string, ref: { sessionId: string; tenantId: string }) => {
        historyStore.set(hash, ref);
        return Promise.resolve();
      },
      lookup: (hash: string) => Promise.resolve(historyStore.get(hash) ?? null),
    };

    const outbox = {
      emit: (event: { name: string }) => {
        events.push(event.name);
        return Promise.resolve();
      },
    };

    const clock = { now: () => NOW };

    return new RefreshUseCase(
      lookup,
      sessions,
      devices,
      users,
      tokens,
      tenants,
      tx,
      grace,
      history,
      outbox,
      clock,
    );
  }

  beforeEach(() => {
    session = {
      id: 's1',
      tenantId: 't1',
      userId: 'u1',
      deviceId: null,
      trustedDevice: true,
      lastUsedAt: new Date('2026-08-05T08:00:00Z'),
      expiresAt: new Date('2026-09-01T00:00:00Z'),
      revokedAt: null,
      revokedReason: null,
    };
    user = { id: 'u1', email: 'admin@tenant-one.test', passwordHash: 'hash', status: 'active' };
    device = null;
    tenantStatus = 'active';
    graceStore = new Map();
    historyStore = new Map();
    rotatedTo = [];
    revokes = [];
    fcmUpdates = [];
    events = [];
  });

  it('BR-AUTH-004 — rotation stores the successor hash and remembers the old one', async () => {
    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshToken).not.toBe(presented);
    // The database holds the *hash* of what the client holds — never the token.
    expect(rotatedTo).toEqual([{ hash: hashToken(result.value.refreshToken), at: NOW }]);
    expect(historyStore.get(hashToken(presented))).toEqual({ sessionId: 's1', tenantId: 't1' });
    expect(graceStore.get(hashToken(presented))).toEqual(result.value);
    expect(result.value.web).toBe(true);
    expect(result.value.persistCookie).toBe(true);
  });

  it('BR-AUTH-005 — inside the grace window the *same* successor pair returns', async () => {
    const useCase = build();
    const first = await useCase.execute({ refreshToken: presented });
    expect(first.ok).toBe(true);

    // The rotated hash no longer matches the session row; only the grace cache
    // can answer — and it must answer identically.
    const replay = await useCase.execute({ refreshToken: presented });

    expect(replay.ok).toBe(true);
    if (!replay.ok || !first.ok) return;
    expect(replay.value).toEqual(first.value);
    expect(rotatedTo).toHaveLength(1);
  });

  it('BR-AUTH-004 — replay past the grace window revokes the whole family', async () => {
    historyStore.set(hashToken(presented), { sessionId: 's1', tenantId: 't1' });
    session = null; // the hash was rotated away — no session row matches it

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_REUSED');
    expect(revokes).toEqual([{ sessionId: 's1', reason: 'token_reuse' }]);
  });

  it('a token in neither store is plain garbage', async () => {
    session = null;

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_INVALID');
    expect(revokes).toHaveLength(0);
  });

  it('BR-AUTH-006 — the absolute cap rejects despite recent use', async () => {
    session = { ...session!, expiresAt: new Date('2026-08-05T09:00:00Z') };

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('BR-AUTH-006 — the web sliding window (7 d) rejects an idle session', async () => {
    session = { ...session!, lastUsedAt: new Date('2026-07-29T09:00:00Z') };

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('BR-AUTH-006 — the same idle age passes on mobile (30 d sliding)', async () => {
    device = {
      id: 'd1',
      userId: 'u1',
      installId: 'i1',
      platform: 'android',
      fcmToken: 'fcm-1',
      status: 'active',
    };
    session = { ...session!, deviceId: 'd1', lastUsedAt: new Date('2026-07-29T09:00:00Z') };

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.web).toBe(false);
  });

  it('BR-AUTH-011 — a suspended tenant blocks refresh', async () => {
    tenantStatus = 'suspended';

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_TENANT_SUSPENDED');
  });

  it('a missing tenant is a stale token, not a suspension', async () => {
    tenantStatus = 'missing';

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('a revoked session answers by its reason: device_revoked is terminal', async () => {
    session = { ...session!, revokedAt: NOW, revokedReason: 'device_revoked' };
    const terminal = await build().execute({ refreshToken: presented });
    expect(!terminal.ok && terminal.error.code).toBe('AUTH_DEVICE_REVOKED');

    session = { ...session, revokedReason: 'logout' };
    const plain = await build().execute({ refreshToken: presented });
    expect(!plain.ok && plain.error.code).toBe('AUTH_REFRESH_INVALID');
  });

  it('BR-AUTH-014 — a revoked device kills the session at this contact', async () => {
    device = {
      id: 'd1',
      userId: 'u1',
      installId: 'i1',
      platform: 'android',
      fcmToken: null,
      status: 'revoked',
    };
    session = { ...session!, deviceId: 'd1' };

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_DEVICE_REVOKED');
    expect(revokes).toEqual([{ sessionId: 's1', reason: 'device_revoked' }]);
    expect(events).toEqual(['auth.session.revoked']);
    expect(rotatedTo).toHaveLength(0);
  });

  it('§9 — refresh rejects a dead user with the one non-committal code', async () => {
    user = { ...user!, status: 'inactive' };

    const result = await build().execute({ refreshToken: presented });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_REFRESH_INVALID');
    expect(rotatedTo).toHaveLength(0);
  });

  it('§9 — a rotated FCM token rides the refresh and is upserted once', async () => {
    device = {
      id: 'd1',
      userId: 'u1',
      installId: 'i1',
      platform: 'android',
      fcmToken: 'fcm-old',
      status: 'active',
    };
    session = { ...session!, deviceId: 'd1' };

    await build().execute({ refreshToken: presented, fcmToken: 'fcm-new' });
    expect(fcmUpdates).toEqual(['fcm-new']);

    // Second refresh reports the now-stored value — no write. The grace cache
    // is cleared so the second call exercises the rotation path, not a replay.
    graceStore = new Map();
    device = { ...device, fcmToken: 'fcm-new' };
    await build().execute({ refreshToken: presented, fcmToken: 'fcm-new' });
    expect(fcmUpdates).toEqual(['fcm-new']);
  });
});
