import { AccountAdminUseCase } from './account-admin.use-case';
import type { UserAccountRecord } from '../domain/auth.ports';

/** BR-AUTH-013: `auth.user.unlock` clears both locks; a miss hides as 404. */
describe('AccountAdminUseCase', () => {
  let user: UserAccountRecord | null;
  let unlocked: string[];
  let counterResets: string[];

  function build(): AccountAdminUseCase {
    const users = {
      findById: () => Promise.resolve(user),
      setPasswordHash: () => Promise.resolve(),
      unlock: (userId: string) => {
        unlocked.push(userId);
        return Promise.resolve(true);
      },
    };
    const attempts = {
      check: () => Promise.resolve(null),
      recordFailure: () => Promise.resolve(),
      recordSuccess: (email: string) => {
        counterResets.push(email);
        return Promise.resolve();
      },
    };
    return new AccountAdminUseCase(users, attempts);
  }

  beforeEach(() => {
    user = { id: 'u1', email: 'locked@tenant-one.test', passwordHash: 'hash', status: 'locked' };
    unlocked = [];
    counterResets = [];
  });

  it('clears the administrative lock AND the timed Redis counter', async () => {
    const result = await build().unlock('admin-1', 'u1');

    expect(result.ok && result.value).toEqual({ id: 'u1' });
    expect(unlocked).toEqual(['u1']);
    expect(counterResets).toEqual(['locked@tenant-one.test']);
  });

  it('an unlocked account is a success no-op that still clears the counter', async () => {
    user = { ...user!, status: 'active' };

    const result = await build().unlock('admin-1', 'u1');

    expect(result.ok).toBe(true);
    expect(unlocked).toHaveLength(0);
    expect(counterResets).toEqual(['locked@tenant-one.test']);
  });

  it('a miss hides as 404', async () => {
    user = null;

    const result = await build().unlock('admin-1', 'u-gone');

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
  });
});
