import { LoginUseCase, type LoginCommand } from './login.use-case';
import type {
  CandidateUser,
  DeviceRecord,
  NewDevice,
  NewSession,
  TenantSummary,
} from '../domain/auth.ports';

/**
 * Hand-written in-memory fakes, no DI container, no database
 * (coding-standards-nestjs §9). Every failure path asserts its **catalog code**
 * and never a message string — a message is not a contract, and tests that read
 * them break on a typo fix and pass through a semantic change.
 *
 * The scenarios are authentication.md §14's for UC-AUTH-001, including the
 * BR-AUTH-007 device-limit ladder. Refresh rotation lives in
 * `refresh.use-case.spec.ts`; reset tokens in `password.use-case.spec.ts`.
 */
describe('LoginUseCase', () => {
  const password = 'skeleton-password-1';

  let users: CandidateUser[];
  let tenants: TenantSummary[];
  let failures: string[];
  let dummyVerifies: number;
  let lockedFor: number | null;
  let devices: (DeviceRecord & { revokedReason?: string })[];
  let createdDevices: NewDevice[];
  let touched: string[];
  let createdSessions: NewSession[];
  let sessionsRevokedForDevice: string[];
  let events: { name: string; payload: Record<string, unknown> }[];

  function build(): LoginUseCase {
    const lookup = {
      findCandidatesByEmail: (email: string) =>
        Promise.resolve(users.filter((u) => u.email === email)),
      findTenants: (ids: readonly string[]) =>
        Promise.resolve(tenants.filter((t) => ids.includes(t.id))),
      findSessionByRefreshHash: () => Promise.resolve(null),
      findAuthTokenByHash: () => Promise.resolve(null),
    };

    const passwords = {
      verify: (hash: string, plaintext: string) => Promise.resolve(hash === `hash:${plaintext}`),
      verifyDummy: () => {
        dummyVerifies += 1;
        return Promise.resolve();
      },
      hash: (plaintext: string) => Promise.resolve(`hash:${plaintext}`),
    };

    const attempts = {
      check: () => Promise.resolve(lockedFor),
      recordFailure: (email: string) => {
        failures.push(email);
        return Promise.resolve();
      },
      recordSuccess: () => Promise.resolve(),
    };

    const tokens = {
      sign: () => Promise.resolve({ token: 'access-token', expiresInSeconds: 900 }),
      // Never called by this use case — verification is the guard's job — but
      // the port declares it, so the fake declares it. That is the whole value
      // of dropping the casts: the compiler now says when a port grows.
      verify: () => Promise.resolve(null),
    };

    const sessions = {
      create: (session: NewSession) => {
        createdSessions.push(session);
        return Promise.resolve('session-id');
      },
      stampLastLogin: () => Promise.resolve(),
      findById: () => Promise.resolve(null),
      rotate: () => Promise.resolve(),
      revoke: () => Promise.resolve(true),
      revokeAllForUser: () => Promise.resolve([]),
      revokeForDevice: (deviceId: string) => {
        sessionsRevokedForDevice.push(deviceId);
        return Promise.resolve(['old-session']);
      },
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const deviceRepo = {
      findByInstallId: (installId: string) =>
        Promise.resolve(devices.find((d) => d.installId === installId) ?? null),
      findById: (id: string) => Promise.resolve(devices.find((d) => d.id === id) ?? null),
      countActiveForUser: (userId: string) =>
        Promise.resolve(devices.filter((d) => d.userId === userId && d.status === 'active').length),
      create: (device: NewDevice) => {
        createdDevices.push(device);
        return Promise.resolve('new-device-id');
      },
      touch: (deviceId: string) => {
        touched.push(deviceId);
        return Promise.resolve();
      },
      updateFcmToken: () => Promise.resolve(),
      revoke: (deviceId: string, reason: 'replaced' | 'user' | 'admin') => {
        const device = devices.find((d) => d.id === deviceId);
        if (device) {
          device.status = 'revoked';
          device.revokedReason = reason;
        }
        return Promise.resolve(true);
      },
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        events.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    const tx = { runInTenant: <T>(_tenantId: string, fn: () => Promise<T>) => fn() };
    const clock = { now: () => new Date('2026-08-05T00:00:00Z') };

    // No casts: the fakes satisfy the ports structurally, which is the point of
    // the ports being interfaces rather than classes. A cast here would hide the
    // day a port gains a method and this file stops covering it.
    return new LoginUseCase(
      lookup,
      passwords,
      attempts,
      tokens,
      sessions,
      deviceRepo,
      outbox,
      tx,
      clock,
    );
  }

  function command(over: Partial<LoginCommand> = {}): LoginCommand {
    return {
      email: 'admin@tenant-one.test',
      password,
      rememberDevice: false,
      ip: '127.0.0.1',
      ...over,
    };
  }

  const mobileDevice = {
    installId: 'install-1',
    platform: 'android' as const,
    model: 'Pixel 8',
    osVersion: '15',
    appVersion: '1.0.0',
    fcmToken: 'fcm-1',
  };

  beforeEach(() => {
    failures = [];
    dummyVerifies = 0;
    lockedFor = null;
    devices = [];
    createdDevices = [];
    touched = [];
    createdSessions = [];
    sessionsRevokedForDevice = [];
    events = [];
    tenants = [
      { id: 't1', name: 'Tenant One', status: 'active' },
      { id: 't2', name: 'Tenant Two', status: 'active' },
    ];
    users = [
      {
        id: 'u1',
        tenantId: 't1',
        email: 'admin@tenant-one.test',
        passwordHash: `hash:${password}`,
        status: 'active',
      },
    ];
  });

  it('issues a session on a sole active match', async () => {
    const result = await build().execute(command());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('session');
  });

  it('BR-AUTH-002 — an unknown email still pays the argon2 cost', async () => {
    const result = await build().execute(command({ email: 'nobody@tenant-one.test' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    // The timing half of the rule. Returning early here is what turns one code
    // into an enumeration oracle, and only this assertion notices.
    expect(dummyVerifies).toBe(1);
  });

  it('BR-AUTH-002 — a wrong password returns the same code as an unknown email', async () => {
    const result = await build().execute(command({ password: 'wrong' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(failures).toEqual(['admin@tenant-one.test']);
  });

  it('BR-AUTH-003 — lockout wins over a correct password', async () => {
    lockedFor = 720;
    const result = await build().execute(command());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    expect(result.error.details).toEqual({ retryAfterSeconds: 720 });
    // Nothing was verified — the check runs before any password work.
    expect(dummyVerifies).toBe(0);
  });

  it('BR-AUTH-001 — two tenants return a picker and no tokens', async () => {
    users.push({ ...users[0]!, id: 'u2', tenantId: 't2' });

    const result = await build().execute(command());

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'picker') throw new Error('expected a picker');
    expect(result.value.tenantChoices.map((c) => c.tenantId)).toEqual(['t1', 't2']);
  });

  it('BR-AUTH-001 — a suspended tenant is absent from the picker', async () => {
    users.push({ ...users[0]!, id: 'u2', tenantId: 't2' });
    tenants = tenants.map((t) => (t.id === 't2' ? { ...t, status: 'suspended' as const } : t));

    const result = await build().execute(command());

    // One selectable match left, so this is a session rather than a one-item
    // picker — the suspended tenant is not merely hidden, it never counted.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('session');
  });

  it('BR-AUTH-011 — a sole suspended match is refused', async () => {
    tenants = [{ id: 't1', name: 'Tenant One', status: 'suspended' }];

    const result = await build().execute(command());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_TENANT_SUSPENDED');
  });

  it('BR-AUTH-013 — an administratively locked account carries no retry hint', async () => {
    users = [{ ...users[0]!, status: 'locked' }];

    const result = await build().execute(command());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_ACCOUNT_LOCKED');
    // No `retryAfterSeconds`: this lock does not time out, it is cleared by
    // `auth.user.unlock`. A countdown would tell the user to wait forever.
    expect(result.error.details).toBeUndefined();
  });

  it('an inactive user is indistinguishable from a wrong password', async () => {
    users = [{ ...users[0]!, status: 'inactive' }];

    const result = await build().execute(command());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('web expiry: 12 hours unremembered, 30 days remembered (ADR-0004)', async () => {
    await build().execute(command());
    await build().execute(command({ rememberDevice: true }));

    expect(createdSessions[0]!.expiresAt).toEqual(new Date('2026-08-05T12:00:00Z'));
    expect(createdSessions[1]!.expiresAt).toEqual(new Date('2026-09-04T00:00:00Z'));
    expect(createdSessions[0]!.deviceId).toBeUndefined();
  });

  it('mobile login registers the device, binds the session, caps at 90 days', async () => {
    const result = await build().execute(command({ device: mobileDevice }));

    expect(result.ok).toBe(true);
    expect(createdDevices).toHaveLength(1);
    expect(createdDevices[0]!.installId).toBe('install-1');
    expect(createdSessions[0]!.deviceId).toBe('new-device-id');
    expect(createdSessions[0]!.expiresAt).toEqual(new Date('2026-11-03T00:00:00Z'));
  });

  it('a known active install is touched and reused, never duplicated', async () => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'install-1',
        platform: 'android',
        fcmToken: 'fcm-0',
        status: 'active',
      },
    ];

    const result = await build().execute(command({ device: mobileDevice }));

    expect(result.ok).toBe(true);
    expect(createdDevices).toHaveLength(0);
    expect(touched).toEqual(['d1']);
    expect(createdSessions[0]!.deviceId).toBe('d1');
  });

  it('BR-AUTH-014 — a revoked install is refused terminally', async () => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'install-1',
        platform: 'android',
        fcmToken: null,
        status: 'revoked',
      },
    ];

    const result = await build().execute(command({ device: mobileDevice }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_DEVICE_REVOKED');
    expect(createdSessions).toHaveLength(0);
  });

  it('BR-AUTH-007 — the device limit refuses a second install with the policy in details', async () => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'other-install',
        platform: 'android',
        fcmToken: null,
        status: 'active',
      },
    ];

    const result = await build().execute(
      command({ device: { ...mobileDevice, installId: 'install-2' } }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_DEVICE_LIMIT_REACHED');
    expect(result.error.details).toEqual({ maxDevices: 1, policy: 'self_service' });
  });

  it('BR-AUTH-007 — self-service replacement revokes the old device and its sessions atomically', async () => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'other-install',
        platform: 'android',
        fcmToken: 'fcm-old',
        status: 'active',
      },
    ];

    const result = await build().execute(
      command({ device: { ...mobileDevice, installId: 'install-2' }, replaceDeviceId: 'd1' }),
    );

    expect(result.ok).toBe(true);
    expect(devices[0]!.status).toBe('revoked');
    expect(devices[0]!.revokedReason).toBe('replaced');
    expect(sessionsRevokedForDevice).toEqual(['d1']);
    expect(createdDevices).toHaveLength(1);
    expect(events.map((e) => e.name)).toEqual(['auth.session.revoked', 'auth.device.revoked']);
  });

  it("BR-AUTH-007 — another user's device id is a plain miss, not a hint", async () => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'other-install',
        platform: 'android',
        fcmToken: null,
        status: 'active',
      },
      {
        id: 'd-foreign',
        userId: 'u-other',
        installId: 'foreign-install',
        platform: 'ios',
        fcmToken: null,
        status: 'active',
      },
    ];

    const result = await build().execute(
      command({
        device: { ...mobileDevice, installId: 'install-2' },
        replaceDeviceId: 'd-foreign',
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SYS_NOT_FOUND');
  });
});
