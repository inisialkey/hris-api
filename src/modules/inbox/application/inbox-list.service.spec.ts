import { runInContextScope, setRequestContext } from '../../../shared/context';
import type { InboxRepositoryPort } from '../domain/inbox.ports';
import type { InboxListQuery } from '../domain/inbox.types';
import { InboxListService } from './inbox-list.service';

const NOW = new Date('2026-03-10T02:00:00Z');

function inScope<T>(userId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return runInContextScope({}, () => {
    setRequestContext({ requestId: 'request-1', userId });
    return fn();
  });
}

describe('InboxListService (UC-INB-003)', () => {
  let seen: { userId: string; query?: InboxListQuery }[];
  let seenStamp: Date | null;
  let service: InboxListService;

  beforeEach(() => {
    seen = [];
    seenStamp = null;

    const items = {
      list: (userId: string, query: InboxListQuery) => {
        seen.push({ userId, query });
        return Promise.resolve({ rows: [], hasMore: false });
      },
      openCount: (userId: string) => {
        seen.push({ userId });
        return Promise.resolve(4);
      },
      markSeen: (_userId: string, _id: string, at: Date) =>
        Promise.resolve(seenStamp ? { seenAt: seenStamp } : { seenAt: at }),
      markAllSeen: (userId: string) => {
        seen.push({ userId });
        return Promise.resolve(6);
      },
    } as unknown as InboxRepositoryPort;

    service = new InboxListService(items, { now: () => NOW });
  });

  it('scopes every read to the request’s own user', async () => {
    // There is no parameter a caller could supply to widen this — §7's
    // "structurally user-scoped" is the whole authorization story here.
    await inScope('user-a', () => service.list({ limit: 20, status: 'open' }));
    await inScope('user-a', () => service.openCount());
    await inScope('user-a', () => service.markAllSeen());

    expect(seen.map((call) => call.userId)).toEqual(['user-a', 'user-a', 'user-a']);
  });

  it('passes the caller’s status and type filters straight through', async () => {
    await inScope('user-a', () =>
      service.list({ limit: 5, status: 'done', type: 'acknowledgment' }),
    );
    expect(seen[0]!.query).toMatchObject({ limit: 5, status: 'done', type: 'acknowledgment' });
  });

  it('counts open items for the badge', async () => {
    expect(await inScope('user-a', () => service.openCount())).toBe(4);
  });

  it('returns the existing stamp when the item was already seen', async () => {
    // The cosmetic replay lane (offline-sync §10) re-sends these on every
    // reconnect, so a second call is the normal case rather than the odd one.
    seenStamp = new Date('2026-03-09T00:00:00Z');
    const result = await inScope('user-a', () => service.markSeen('item-1'));
    expect(result).toEqual({
      ok: true,
      value: { id: 'item-1', seenAt: new Date('2026-03-09T00:00:00Z') },
    });
  });

  it('answers 404 when the item is not the caller’s', async () => {
    const items = { markSeen: () => Promise.resolve(null) } as unknown as InboxRepositoryPort;
    service = new InboxListService(items, { now: () => NOW });

    const result = await inScope('user-a', () => service.markSeen('item-1'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('refuses to read anything without a proven identity', () => {
    // A wiring fault, not a 401 to render from inside a use case: every route
    // here is `@AuthenticatedOnly()` and the guard chain runs first. It throws
    // rather than returning a rejected promise because the identity is read
    // before the query is built — which is the point, since a query built
    // without it would be the unscoped one.
    expect(() =>
      runInContextScope({}, () => {
        setRequestContext({ requestId: 'request-1' });
        return service.openCount();
      }),
    ).toThrow('inbox read outside an authenticated request');
  });
});
