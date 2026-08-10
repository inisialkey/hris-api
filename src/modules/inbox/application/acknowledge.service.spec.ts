import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { InboxOutboxPort, InboxRepositoryPort } from '../domain/inbox.ports';
import type { InboxItemRow } from '../domain/inbox.types';
import { AcknowledgeService } from './acknowledge.service';

const NOW = new Date('2026-03-10T02:00:00Z');

function item(overrides: Partial<InboxItemRow> = {}): InboxItemRow {
  return {
    id: 'item-1',
    userId: 'user-a',
    type: 'acknowledgment',
    status: 'open',
    dedupeKey: 'announcement-1',
    title: 'Perlu konfirmasi baca · Libur',
    subtitle: null,
    params: {},
    sourceRef: { announcementId: 'announcement-1' },
    deepLink: 'announcements/announcement-1',
    dueAt: null,
    seenAt: null,
    doneAt: null,
    closedReason: null,
    createdAt: NOW,
    ...overrides,
  };
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return runInContextScope({}, () => {
    setTenantContext({ tenantId: 'tenant-1', source: 'jwt' });
    setRequestContext({ requestId: 'request-1', userId: 'user-a' });
    return fn();
  });
}

describe('AcknowledgeService (UC-INB-004)', () => {
  let stored: InboxItemRow | null;
  let emitted: { name: string; payload: Record<string, unknown> }[];
  let completions: number;
  let service: AcknowledgeService;

  beforeEach(() => {
    stored = item();
    emitted = [];
    completions = 0;

    const items = {
      findOwned: (userId: string) =>
        Promise.resolve(stored && stored.userId === userId ? stored : null),
      complete: () => {
        if (!stored || stored.status !== 'open') return Promise.resolve(null);
        completions += 1;
        stored = { ...stored, status: 'done', doneAt: NOW };
        return Promise.resolve({ doneAt: NOW });
      },
    } as unknown as InboxRepositoryPort;

    const outbox: InboxOutboxPort = {
      emit: (event) => {
        emitted.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    };

    service = new AcknowledgeService(items, outbox, { now: () => NOW });
  });

  it('completes an open ack item and emits the fact', async () => {
    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result).toEqual({ ok: true, value: { id: 'item-1', doneAt: NOW } });
    expect(emitted).toEqual([
      {
        name: 'inbox.item.acknowledged',
        payload: {
          itemId: 'item-1',
          userId: 'user-a',
          sourceRef: { announcementId: 'announcement-1' },
        },
      },
    ]);
  });

  it('replays a done item as success with the same stamp and no second event', async () => {
    // BR-INB-008 — the offline queue drains a week later, or the second device
    // taps. An event per tap would make announcement's ack rate a tap count.
    stored = item({ status: 'done', doneAt: new Date('2026-03-09T00:00:00Z') });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result).toEqual({
      ok: true,
      value: { id: 'item-1', doneAt: new Date('2026-03-09T00:00:00Z') },
    });
    expect(emitted).toHaveLength(0);
    expect(completions).toBe(0);
  });

  it('refuses an approval task before asking about its state', async () => {
    // BR-INB-008's order. A *closed* approval task must not answer
    // `INB_ITEM_CLOSED`, which tells the client to show a retracted-post notice.
    stored = item({ type: 'approval_task', status: 'closed', closedReason: 'superseded' });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INB_NOT_ACKNOWLEDGEABLE');
  });

  it('refuses a retracted item and names the reason in details', async () => {
    stored = item({ status: 'closed', closedReason: 'retracted' });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INB_ITEM_CLOSED');
    expect(result.ok === false && result.error.details).toEqual({ closedReason: 'retracted' });
  });

  it('answers 404 for another user’s item', async () => {
    stored = item({ userId: 'user-b' });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SYS_NOT_FOUND');
    expect(emitted).toHaveLength(0);
  });

  it('resolves a two-device race to the winner’s stamp', async () => {
    // The read saw `open`, the update matched nothing because the other device
    // committed in between. The answer is the same success, not a conflict
    // nobody can act on.
    const earlier = new Date('2026-03-09T00:00:00Z');
    const items = {
      findOwned: () =>
        Promise.resolve(completions === 0 ? item() : item({ status: 'done', doneAt: earlier })),
      complete: () => {
        completions += 1;
        return Promise.resolve(null);
      },
    } as unknown as InboxRepositoryPort;
    service = new AcknowledgeService(items, { emit: () => Promise.resolve() }, { now: () => NOW });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result).toEqual({ ok: true, value: { id: 'item-1', doneAt: earlier } });
  });

  it('answers INB_ITEM_CLOSED when a retraction lands mid-flight', async () => {
    // The read saw `open`, the retraction committed, the update matched nothing.
    // A 404 here would send the client looking for a bug in a row that exists.
    let reads = 0;
    const items = {
      findOwned: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? item() : item({ status: 'closed', closedReason: 'retracted' }),
        );
      },
      complete: () => Promise.resolve(null),
    } as unknown as InboxRepositoryPort;
    service = new AcknowledgeService(items, { emit: () => Promise.resolve() }, { now: () => NOW });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INB_ITEM_CLOSED');
  });

  it('answers 404 when the item is gone by the time the update runs', async () => {
    let reads = 0;
    const items = {
      findOwned: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? item() : null);
      },
      complete: () => Promise.resolve(null),
    } as unknown as InboxRepositoryPort;
    service = new AcknowledgeService(items, { emit: () => Promise.resolve() }, { now: () => NOW });

    const result = await inScope(() => service.acknowledge('item-1'));

    expect(result.ok === false && result.error.code).toBe('SYS_NOT_FOUND');
  });
});
