import { DeviceUseCase } from './device.use-case';
import type { SessionActor } from './session.use-case';
import type { DeviceRecord } from '../domain/auth.ports';

/** UC-AUTH-005: the cascade — device, sessions, FCM — and the mirror rules. */
describe('DeviceUseCase', () => {
  const NOW = new Date('2026-08-05T09:00:00Z');

  let devices: DeviceRecord[];
  let deviceRevokes: { deviceId: string; reason: string }[];
  let revokeResult: boolean;
  let sessionCascades: string[];
  let events: string[];

  function actor(canActOnOthers = false): SessionActor {
    return {
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's-acting',
      canActOnOthers: () => Promise.resolve(canActOnOthers),
    };
  }

  function build(): DeviceUseCase {
    const deviceRepo = {
      findByInstallId: () => Promise.resolve(null),
      findById: (id: string) => Promise.resolve(devices.find((d) => d.id === id) ?? null),
      countActiveForUser: () => Promise.resolve(0),
      create: () => Promise.resolve('unused'),
      touch: () => Promise.resolve(),
      updateFcmToken: () => Promise.resolve(),
      revoke: (deviceId: string, reason: 'replaced' | 'user' | 'admin') => {
        deviceRevokes.push({ deviceId, reason });
        return Promise.resolve(revokeResult);
      },
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const sessions = {
      create: () => Promise.resolve('unused'),
      stampLastLogin: () => Promise.resolve(),
      findById: () => Promise.resolve(null),
      rotate: () => Promise.resolve(),
      revoke: () => Promise.resolve(true),
      revokeAllForUser: () => Promise.resolve([]),
      revokeForDevice: (deviceId: string) => {
        sessionCascades.push(deviceId);
        return Promise.resolve(['s-mobile']);
      },
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const outbox = {
      emit: (event: { name: string }) => {
        events.push(event.name);
        return Promise.resolve();
      },
    };

    return new DeviceUseCase(deviceRepo, sessions, outbox, { now: () => NOW });
  }

  beforeEach(() => {
    devices = [
      {
        id: 'd1',
        userId: 'u1',
        installId: 'i1',
        platform: 'android',
        fcmToken: 'fcm-1',
        status: 'active',
      },
    ];
    deviceRevokes = [];
    revokeResult = true;
    sessionCascades = [];
    events = [];
  });

  it('UC-AUTH-005 — revoke cascades sessions and emits both events', async () => {
    const result = await build().revoke(actor(), 'd1');

    expect(result.ok && result.value).toEqual({ id: 'd1' });
    expect(deviceRevokes).toEqual([{ deviceId: 'd1', reason: 'user' }]);
    expect(sessionCascades).toEqual(['d1']);
    expect(events).toEqual(['auth.session.revoked', 'auth.device.revoked']);
  });

  it('an already-revoked device is a success no-op with no second cascade', async () => {
    revokeResult = false;

    const result = await build().revoke(actor(), 'd1');

    expect(result.ok).toBe(true);
    expect(sessionCascades).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("another user's device without the key hides as 404; with it, reason admin", async () => {
    devices = [{ ...devices[0]!, userId: 'u2' }];

    const denied = await build().revoke(actor(false), 'd1');
    expect(!denied.ok && denied.error.code).toBe('SYS_NOT_FOUND');

    const allowed = await build().revoke(actor(true), 'd1');
    expect(allowed.ok).toBe(true);
    expect(deviceRevokes).toEqual([{ deviceId: 'd1', reason: 'admin' }]);
  });

  it("§7 — another user's device list needs the key", async () => {
    const denied = await build().list(actor(false), { userId: 'u2', page: 1, pageSize: 20 });
    expect(!denied.ok && denied.error.code).toBe('SYS_NOT_FOUND');

    const allowed = await build().list(actor(true), { userId: 'u2', page: 1, pageSize: 20 });
    expect(allowed.ok).toBe(true);
  });
});
