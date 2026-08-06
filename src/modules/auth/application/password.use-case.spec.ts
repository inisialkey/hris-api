import { hashToken } from './refresh-token';
import { PasswordUseCase } from './password.use-case';
import type { AuthTokenRecord, CandidateUser, UserAccountRecord } from '../domain/auth.ports';

/**
 * UC-AUTH-006/007/008 — §14's credential rows: single-use tokens with one code
 * per purpose, reset revokes all, change revokes others and never feeds the
 * lockout counter.
 */
describe('PasswordUseCase', () => {
  const NOW = new Date('2026-08-05T09:00:00Z');
  const rawToken = 'raw-reset-token';

  let candidates: CandidateUser[];
  let tokenRow: AuthTokenRecord | null;
  let consumed: string[];
  let consumeResult: boolean;
  let createdTokens: { userId: string; purpose: string; expiresAt: Date; createdBy?: string }[];
  let user: UserAccountRecord | null;
  let setHashes: { userId: string; hash: string }[];
  let revokeAlls: { userId: string; reason: string; except?: string }[];
  let successResets: string[];
  let failureRecords: string[];
  let events: { name: string; payload: Record<string, unknown> }[];

  function build(): PasswordUseCase {
    const lookup = {
      findCandidatesByEmail: () => Promise.resolve(candidates),
      findTenants: () => Promise.resolve([]),
      findSessionByRefreshHash: () => Promise.resolve(null),
      findAuthTokenByHash: (hash: string) =>
        Promise.resolve(tokenRow && hash === hashToken(rawToken) ? tokenRow : null),
    };

    const tokens = {
      create: (token: {
        userId: string;
        purpose: 'password_reset' | 'invite';
        expiresAt: Date;
        createdBy?: string;
      }) => {
        createdTokens.push(token);
        return Promise.resolve('token-id');
      },
      consume: (tokenId: string) => {
        consumed.push(tokenId);
        return Promise.resolve(consumeResult);
      },
    };

    const users = {
      findById: () => Promise.resolve(user),
      setPasswordHash: (userId: string, hash: string) => {
        setHashes.push({ userId, hash });
        return Promise.resolve();
      },
      unlock: () => Promise.resolve(true),
    };

    const sessions = {
      create: () => Promise.resolve('unused'),
      stampLastLogin: () => Promise.resolve(),
      findById: () => Promise.resolve(null),
      rotate: () => Promise.resolve(),
      revoke: () => Promise.resolve(true),
      revokeAllForUser: (userId: string, reason: string, _now: Date, except?: string) => {
        revokeAlls.push({ userId, reason, except });
        return Promise.resolve(['s-dead']);
      },
      revokeForDevice: () => Promise.resolve([]),
      listForUser: () => Promise.resolve({ rows: [], total: 0 }),
    };

    const passwords = {
      hash: (plaintext: string) => Promise.resolve(`hash:${plaintext}`),
      verify: (hash: string, plaintext: string) => Promise.resolve(hash === `hash:${plaintext}`),
      verifyDummy: () => Promise.resolve(),
    };

    const attempts = {
      check: () => Promise.resolve(null),
      recordFailure: (email: string) => {
        failureRecords.push(email);
        return Promise.resolve();
      },
      recordSuccess: (email: string) => {
        successResets.push(email);
        return Promise.resolve();
      },
    };

    const tx = { runInTenant: <T>(_tenantId: string, fn: () => Promise<T>) => fn() };

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        events.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    const clock = { now: () => NOW };

    return new PasswordUseCase(
      lookup,
      tokens,
      users,
      sessions,
      passwords,
      attempts,
      tx,
      outbox,
      clock,
    );
  }

  beforeEach(() => {
    candidates = [
      {
        id: 'u1',
        tenantId: 't1',
        email: 'admin@tenant-one.test',
        passwordHash: 'hash:old-password-1',
        status: 'active',
      },
    ];
    tokenRow = {
      id: 'tok1',
      tenantId: 't1',
      userId: 'u1',
      purpose: 'password_reset',
      expiresAt: new Date('2026-08-05T09:30:00Z'),
      usedAt: null,
    };
    consumed = [];
    consumeResult = true;
    createdTokens = [];
    user = {
      id: 'u1',
      email: 'admin@tenant-one.test',
      passwordHash: 'hash:old-password-1',
      status: 'active',
    };
    setHashes = [];
    revokeAlls = [];
    successResets = [];
    failureRecords = [];
    events = [];
  });

  it('BR-AUTH-010 — a request creates one 30-minute token per active membership', async () => {
    candidates.push({ ...candidates[0]!, id: 'u2', tenantId: 't2' });
    candidates.push({ ...candidates[0]!, id: 'u3', tenantId: 't3', status: 'inactive' });

    await build().requestReset('Admin@Tenant-One.test ');

    expect(createdTokens.map((t) => t.userId)).toEqual(['u1', 'u2']);
    expect(createdTokens[0]!.purpose).toBe('password_reset');
    expect(createdTokens[0]!.expiresAt).toEqual(new Date('2026-08-05T09:30:00Z'));
  });

  it('BR-AUTH-009 — a confirmed reset revokes ALL sessions and clears the lockout', async () => {
    const result = await build().confirmReset(rawToken, 'brand-new-password-1');

    expect(result.ok).toBe(true);
    expect(consumed).toEqual(['tok1']);
    expect(setHashes).toEqual([{ userId: 'u1', hash: 'hash:brand-new-password-1' }]);
    // No `except`: reset kills everything, unlike change.
    expect(revokeAlls).toEqual([{ userId: 'u1', reason: 'password_reset', except: undefined }]);
    expect(events.map((e) => e.name)).toEqual(['auth.session.revoked', 'auth.password.changed']);
    expect(events[1]!.payload).toEqual({ userId: 'u1', via: 'reset' });
    // "Unlock via reset" — the fresh credential works immediately.
    expect(successResets).toEqual(['admin@tenant-one.test']);
  });

  it('BR-AUTH-010 — expired, used, wrong-purpose and unknown are one code', async () => {
    tokenRow = { ...tokenRow!, expiresAt: new Date('2026-08-05T09:00:00Z') };
    const expired = await build().confirmReset(rawToken, 'brand-new-password-1');
    expect(!expired.ok && expired.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

    tokenRow = { ...tokenRow, expiresAt: new Date('2026-08-05T09:30:00Z'), usedAt: NOW };
    const used = await build().confirmReset(rawToken, 'brand-new-password-1');
    expect(!used.ok && used.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

    tokenRow = { ...tokenRow, usedAt: null, purpose: 'invite' };
    const wrongPurpose = await build().confirmReset(rawToken, 'brand-new-password-1');
    expect(!wrongPurpose.ok && wrongPurpose.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

    tokenRow = null;
    const unknown = await build().confirmReset(rawToken, 'brand-new-password-1');
    expect(!unknown.ok && unknown.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

    expect(setHashes).toHaveLength(0);
  });

  it('BR-AUTH-010 — the consuming UPDATE is the single-use gate, not the read', async () => {
    consumeResult = false; // a racing confirm won the row

    const result = await build().confirmReset(rawToken, 'brand-new-password-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_RESET_TOKEN_INVALID');
    expect(setHashes).toHaveLength(0);
  });

  it('the policy refuses a derived password with field entries', async () => {
    const result = await build().confirmReset(rawToken, 'admin-is-my-password');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_PASSWORD_POLICY_VIOLATION');
    const entries = (result.error.details as Record<string, { code: string }[]>)['__fieldEntries'];
    expect(entries?.map((e) => e.code)).toEqual(['AUTH_PASSWORD_DERIVED']);
    expect(consumed).toHaveLength(0);
  });

  it('BR-AUTH-009 — change verifies current, revokes others, spares the acting session', async () => {
    const result = await build().change(
      { userId: 'u1', sessionId: 's-acting', tenantId: 't1' },
      'old-password-1',
      'brand-new-password-1',
    );

    expect(result.ok).toBe(true);
    expect(setHashes).toEqual([{ userId: 'u1', hash: 'hash:brand-new-password-1' }]);
    expect(revokeAlls).toEqual([{ userId: 'u1', reason: 'password_change', except: 's-acting' }]);
    expect(events[1]!.payload).toEqual({ userId: 'u1', via: 'change' });
  });

  it('UC-AUTH-007 — a wrong current password is AUTH_INVALID_CREDENTIALS and feeds no counter', async () => {
    const result = await build().change(
      { userId: 'u1', sessionId: 's-acting', tenantId: 't1' },
      'not-the-password',
      'brand-new-password-1',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(failureRecords).toHaveLength(0);
    expect(setHashes).toHaveLength(0);
  });

  it('UC-AUTH-008 — invite accept consumes with its own code and sets the first credential', async () => {
    tokenRow = { ...tokenRow!, purpose: 'invite', expiresAt: new Date('2026-08-12T09:00:00Z') };

    const accepted = await build().acceptInvite(rawToken, 'brand-new-password-1');
    expect(accepted.ok).toBe(true);
    expect(setHashes).toEqual([{ userId: 'u1', hash: 'hash:brand-new-password-1' }]);
    // No password.changed event for a first credential — nothing changed.
    expect(events.map((e) => e.name)).toEqual(['auth.session.revoked']);

    tokenRow = { ...tokenRow, purpose: 'password_reset' };
    const wrongPurpose = await build().acceptInvite(rawToken, 'brand-new-password-1');
    expect(!wrongPurpose.ok && wrongPurpose.error.code).toBe('AUTH_INVITE_TOKEN_INVALID');
  });

  it('the admin trigger stamps created_by and hides a miss as 404', async () => {
    const issued = await build().requestResetForUser({ userId: 'admin-1', tenantId: 't1' }, 'u1');
    expect(issued.ok).toBe(true);
    expect(createdTokens).toEqual([
      expect.objectContaining({ userId: 'u1', purpose: 'password_reset', createdBy: 'admin-1' }),
    ]);

    user = null;
    const miss = await build().requestResetForUser({ userId: 'admin-1', tenantId: 't1' }, 'u-gone');
    expect(!miss.ok && miss.error.code).toBe('SYS_NOT_FOUND');
  });
});
