import { SessionUseCase, type SessionActor } from './session.use-case';
import type { SessionListRow, SessionRecord } from '../domain/auth.ports';

/** UC-AUTH-003/004: idempotent logout, existence-hiding lists, scoped revokes. */
describe('SessionUseCase', () => {
  const NOW = new Date('2026-08-05T09:00:00Z');

  let rows: SessionRecord[];
  let listRows: SessionListRow[];
  let revokes: { sessionId: string; reason: string }[];
  let revokeResult: boolean;
  let events: { name: string; payload: Record<string, unknown> }[];
  let resolves: number;

  function actor(canActOnOthers = false): SessionActor {
    return {
      tenantId: 't1',
      userId: 'u1',
      sessionId: 's-acting',
      canActOnOthers: () => {
        resolves += 1;
        return Promise.resolve(canActOnOthers);
      },
    };
  }

  function build(): SessionUseCase {
    const sessions = {
      create: () => Promise.resolve('unused'),
      stampLastLogin: () => Promise.resolve(),
      findById: (id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
      rotate: () => Promise.resolve(),
      revoke: (sessionId: string, reason: string) => {
        revokes.push({ sessionId, reason });
        return Promise.resolve(revokeResult);
      },
      revokeAllForUser: (_userId: string, reason: string, _now: Date, except?: string) => {
        const dead = rows.filter((r) => r.id !== except).map((r) => r.id);
        dead.forEach((id) => revokes.push({ sessionId: id, reason }));
        return Promise.resolve(dead);
      },
      revokeForDevice: () => Promise.resolve([]),
      listForUser: () => Promise.resolve({ rows: listRows, total: listRows.length }),
    };

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        events.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    return new SessionUseCase(sessions, outbox, { now: () => NOW });
  }

  function sessionRecord(over: Partial<SessionRecord>): SessionRecord {
    return {
      id: 's-acting',
      tenantId: 't1',
      userId: 'u1',
      deviceId: null,
      trustedDevice: false,
      lastUsedAt: NOW,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
      revokedAt: null,
      revokedReason: null,
      ...over,
    };
  }

  beforeEach(() => {
    rows = [sessionRecord({})];
    listRows = [];
    revokes = [];
    revokeResult = true;
    events = [];
    resolves = 0;
  });

  it('UC-AUTH-003 — logout revokes the acting session and stays a success when dead', async () => {
    const first = await build().logout(actor());
    expect(first.ok && first.value).toEqual({ id: 's-acting' });
    expect(revokes).toEqual([{ sessionId: 's-acting', reason: 'logout' }]);
    expect(events.map((e) => e.name)).toEqual(['auth.session.revoked']);

    revokeResult = false; // already revoked
    events = [];
    const again = await build().logout(actor());
    expect(again.ok && again.value).toEqual({ id: 's-acting' });
    // Dead already — no second event lies about a second revocation.
    expect(events).toHaveLength(0);
  });

  it('UC-AUTH-004 — the list marks the acting session and never resolves permissions for own scope', async () => {
    listRows = [
      {
        id: 's-acting',
        deviceSummary: null,
        ip: '127.0.0.1',
        userAgent: 'ua',
        createdAt: NOW,
        lastUsedAt: NOW,
        trustedDevice: false,
      },
      {
        id: 's-other',
        deviceSummary: 'Pixel 8 (android)',
        ip: '127.0.0.2',
        userAgent: null,
        createdAt: NOW,
        lastUsedAt: NOW,
        trustedDevice: true,
      },
    ];

    const result = await build().list(actor(), { page: 1, pageSize: 20 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.current)).toEqual([true, false]);
    // ADR-0005's lazy rule, observable: own scope pays no resolution.
    expect(resolves).toBe(0);
  });

  it("§7 — another user's list without the key is a 404, with it a page", async () => {
    const denied = await build().list(actor(false), { userId: 'u2', page: 1, pageSize: 20 });
    expect(!denied.ok && denied.error.code).toBe('SYS_NOT_FOUND');

    const allowed = await build().list(actor(true), { userId: 'u2', page: 1, pageSize: 20 });
    expect(allowed.ok).toBe(true);
  });

  it('UC-AUTH-004 — revoking the acting session behaves as logout', async () => {
    const result = await build().revoke(actor(), 's-acting');

    expect(result.ok).toBe(true);
    expect(revokes).toEqual([{ sessionId: 's-acting', reason: 'logout' }]);
  });

  it("UC-AUTH-004 — an admin revoke of another user's session carries reason admin", async () => {
    rows = [sessionRecord({ id: 's-foreign', userId: 'u2' })];

    const denied = await build().revoke(actor(false), 's-foreign');
    expect(!denied.ok && denied.error.code).toBe('SYS_NOT_FOUND');

    const allowed = await build().revoke(actor(true), 's-foreign');
    expect(allowed.ok).toBe(true);
    expect(revokes).toEqual([{ sessionId: 's-foreign', reason: 'admin' }]);
    expect(events[0]!.payload).toEqual({
      sessionId: 's-foreign',
      userId: 'u2',
      reason: 'admin',
    });
  });

  it('an unknown session id is a plain miss', async () => {
    const result = await build().revoke(actor(true), 's-gone');
    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('UC-AUTH-004 — revoke-others spares the acting session and counts the dead', async () => {
    rows = [sessionRecord({}), sessionRecord({ id: 's2' }), sessionRecord({ id: 's3' })];

    const result = await build().revokeOthers(actor());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revokedCount).toBe(2);
    expect(revokes.map((r) => r.sessionId)).toEqual(['s2', 's3']);
    expect(events).toHaveLength(2);
  });
});
