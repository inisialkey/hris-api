import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { InboxRepositoryPort, NewInboxItem } from '../domain/inbox.ports';
import type { ClosedReason } from '../domain/inbox.types';
import { ACK_CHUNK, AckItemsService } from './ack-items.service';

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return runInContextScope({}, () => {
    setTenantContext({ tenantId: 'tenant-1', source: 'job' });
    return fn();
  });
}

describe('AckItemsService (UC-INB-005)', () => {
  let chunks: NewInboxItem[][];
  let closedWith: { dedupeKey: string; reason: ClosedReason } | null;
  let newPerChunk: (size: number) => number;
  let service: AckItemsService;

  beforeEach(() => {
    chunks = [];
    closedWith = null;
    newPerChunk = (size) => size;

    const items = {
      insertIfNew: (batch: readonly NewInboxItem[]) => {
        chunks.push([...batch]);
        return Promise.resolve(newPerChunk(batch.length));
      },
      closeByDedupeKey: (dedupeKey: string, reason: ClosedReason) => {
        closedWith = { dedupeKey, reason };
        return Promise.resolve(3);
      },
    } as unknown as InboxRepositoryPort;

    service = new AckItemsService(items);
  });

  it('renders the title once and keys every item on the announcement id', async () => {
    const report = await inScope(() =>
      service.createAckItems({
        announcementId: 'announcement-1',
        userIds: ['user-a', 'user-b'],
        titleParams: { subject: 'Libur Idulfitri' },
        deepLink: 'announcements/announcement-1',
      }),
    );

    expect(report).toEqual({ created: 2, deduped: 0 });
    // BR-INB-004 — the announcement id, which inbox wrote into the rule before
    // announcement.md existed.
    expect(chunks[0]!.map((item) => item.dedupeKey)).toEqual(['announcement-1', 'announcement-1']);
    expect(chunks[0]![0]!.title).toBe('Perlu konfirmasi baca · Libur Idulfitri');
    expect(chunks[0]![0]!.type).toBe('acknowledgment');
    expect(chunks[0]![0]!.sourceRef).toEqual({ announcementId: 'announcement-1' });
    // The caller's link: announcement is the one module that can name its own
    // route, because it owns the screen.
    expect(chunks[0]![0]!.deepLink).toBe('announcements/announcement-1');
  });

  it('carries the optional acknowledge-by deadline and defaults it to null', async () => {
    const dueAt = new Date('2026-03-20T00:00:00Z');
    await inScope(() =>
      service.createAckItems({
        announcementId: 'a',
        userIds: ['user-a'],
        titleParams: { subject: 's' },
        deepLink: 'd',
        dueAt,
      }),
    );
    expect(chunks[0]![0]!.dueAt).toBe(dueAt);

    await inScope(() =>
      service.createAckItems({
        announcementId: 'b',
        userIds: ['user-a'],
        titleParams: { subject: 's' },
        deepLink: 'd',
      }),
    );
    expect(chunks[1]![0]!.dueAt).toBeNull();
  });

  it('chunks at 500 and dedupes the recipient list', async () => {
    const userIds = [...Array.from({ length: 501 }, (_, index) => `user-${index}`), 'user-0'];

    const report = await inScope(() =>
      service.createAckItems({
        announcementId: 'a',
        userIds,
        titleParams: { subject: 's' },
        deepLink: 'd',
      }),
    );

    expect(chunks.map((chunk) => chunk.length)).toEqual([ACK_CHUNK, 1]);
    expect(report.created).toBe(501);
  });

  it('reports rows the dedupe index already held as deduped, not created', async () => {
    // A fan-out job that failed halfway and retried: UC-ANN-005's *"every step
    // idempotent; a retry converges rather than duplicating"*.
    newPerChunk = () => 0;

    const report = await inScope(() =>
      service.createAckItems({
        announcementId: 'a',
        userIds: ['user-a', 'user-b'],
        titleParams: { subject: 's' },
        deepLink: 'd',
      }),
    );

    expect(report).toEqual({ created: 0, deduped: 2 });
  });

  it('closes open items as retracted', async () => {
    expect(await service.closeAckItems('announcement-1')).toBe(3);
    expect(closedWith).toEqual({ dedupeKey: 'announcement-1', reason: 'retracted' });
  });
});
