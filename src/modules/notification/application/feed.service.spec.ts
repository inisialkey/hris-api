import { runInContextScope, setRequestContext } from '../../../shared/context';
import type { NotificationRepositoryPort } from '../domain/notification.ports';
import { FeedService } from './feed.service';

const NOW = new Date('2026-03-10T02:00:00Z');
const EARLIER = new Date('2026-03-09T02:00:00Z');

describe('FeedService (UC-NTF-004)', () => {
  let readAt: Date | null | undefined;
  let markReadCalls: { userId: string; id: string }[];
  let feed: FeedService;

  beforeEach(() => {
    readAt = undefined;
    markReadCalls = [];

    const repository: NotificationRepositoryPort = {
      insertIfNew: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      feed: (userId) =>
        Promise.resolve({
          rows: [
            {
              id: 'n-1',
              templateKey: 'announcement.published',
              title: `for ${userId}`,
              body: 'x',
              deepLink: null,
              readAt: null,
              createdAt: NOW,
            },
          ],
          hasMore: false,
        }),
      unreadCount: () => Promise.resolve(7),
      markRead: (userId, id) => {
        markReadCalls.push({ userId, id });
        return Promise.resolve(readAt === undefined ? null : { readAt: readAt ?? NOW });
      },
      markAllRead: () => Promise.resolve(3),
      deleteCreatedBefore: () => Promise.resolve(0),
    };

    feed = new FeedService(repository, { now: () => NOW });
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      setRequestContext({ requestId: 'r-1', userId: 'u-1' });
      return fn();
    });

  it('scopes every read to the requesting user, with no parameter to widen it', async () => {
    const found = await run(() => feed.list({ limit: 20, unreadOnly: false }));

    expect(found.rows[0]!.title).toBe('for u-1');
  });

  it('answers the badge from a live count', async () => {
    await expect(run(() => feed.unreadCount())).resolves.toBe(7);
  });

  it('returns 404 for a row that is not the caller’s', async () => {
    // §7 — *"others' rows → 404"*. Existence hiding, not a 403.
    readAt = undefined;

    const result = await run(() => feed.markRead('n-9'));

    expect(!result.ok && result.error.code).toBe('SYS_NOT_FOUND');
    expect(markReadCalls).toEqual([{ userId: 'u-1', id: 'n-9' }]);
  });

  it('is idempotent — a second mark-read returns the first stamp', async () => {
    readAt = EARLIER;

    const result = await run(() => feed.markRead('n-1'));

    expect(result.ok && result.value.readAt).toBe(EARLIER);
  });

  it('reports how many rows read-all touched', async () => {
    await expect(run(() => feed.markAllRead())).resolves.toEqual({ updatedCount: 3 });
  });
});
