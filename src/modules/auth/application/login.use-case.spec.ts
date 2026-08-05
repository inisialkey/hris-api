import { LoginUseCase, type LoginCommand } from './login.use-case';
import type { CandidateUser, TenantSummary } from '../domain/auth.ports';

/**
 * Hand-written in-memory fakes, no DI container, no database
 * (coding-standards-nestjs §9). Every failure path asserts its **catalog code**
 * and never a message string — a message is not a contract, and tests that read
 * them break on a typo fix and pass through a semantic change.
 *
 * The scenarios are authentication.md §14's, restricted to the ones the walking
 * skeleton implements. Device limits, refresh rotation and reset tokens are not
 * here because they are not built; §14's rows for them stay open rather than
 * being answered by a test of something else.
 */
describe('LoginUseCase', () => {
  const password = 'skeleton-password-1';

  let users: CandidateUser[];
  let tenants: TenantSummary[];
  let failures: string[];
  let dummyVerifies: number;
  let lockedFor: number | null;

  function build(): LoginUseCase {
    const lookup = {
      findCandidatesByEmail: (email: string) =>
        Promise.resolve(users.filter((u) => u.email === email)),
      findTenants: (ids: readonly string[]) =>
        Promise.resolve(tenants.filter((t) => ids.includes(t.id))),
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
      create: () => Promise.resolve('session-id'),
      stampLastLogin: () => Promise.resolve(),
    };
    const tx = { runInTenant: <T>(_tenantId: string, fn: () => Promise<T>) => fn() };
    const clock = { now: () => new Date('2026-08-05T00:00:00Z') };

    // No casts: the fakes satisfy the ports structurally, which is the point of
    // the ports being interfaces rather than classes. A cast here would hide the
    // day a port gains a method and this file stops covering it.
    return new LoginUseCase(lookup, passwords, attempts, tokens, sessions, tx, clock);
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

  beforeEach(() => {
    failures = [];
    dummyVerifies = 0;
    lockedFor = null;
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
});
