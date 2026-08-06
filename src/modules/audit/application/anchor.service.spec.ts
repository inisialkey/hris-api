import { runInContextScope, setTenantContext } from '../../../shared/context';
import { computeDigest } from '../domain/audit-digest';
import type { AnchorRecord, AuditLogRow } from '../domain/audit.ports';
import { AnchorService } from './anchor.service';

/** UC-AUD-005: chain the days, back-fill the gaps, and answer honestly about both. */
describe('AnchorService', () => {
  const NOW = new Date('2026-08-06T02:00:00Z');

  let anchors: { tenantId: string; anchor: AnchorRecord }[];
  let rowsByDay: Record<string, AuditLogRow[]>;
  let inserts: number;

  function row(id: string, over: Partial<AuditLogRow> = {}): AuditLogRow {
    return {
      id,
      occurredAt: new Date('2026-08-05T10:00:00.000Z'),
      actorType: 'user',
      actorUserId: 'u1',
      impersonatorId: null,
      requestId: 'req-1',
      action: 'holidays.updated',
      entityType: 'holidays',
      entityId: null,
      diff: null,
      metadata: null,
      eventId: null,
      ...over,
    };
  }

  function build(): AnchorService {
    const logs = {
      append: () => Promise.resolve('unused'),
      findById: () => Promise.resolve(null),
      list: () => Promise.resolve({ rows: [], hasMore: false }),
      listForAnchorDay: (day: string) => Promise.resolve(rowsByDay[day] ?? []),
    };

    const anchorRepository = {
      findByDay: (day: string) =>
        Promise.resolve(anchors.find((a) => a.anchor.day === day)?.anchor ?? null),
      findPreviousDigest: (day: string) => {
        const earlier = anchors
          .filter((a) => a.anchor.day < day)
          .sort((a, b) => (a.anchor.day < b.anchor.day ? 1 : -1));
        return Promise.resolve(earlier[0]?.anchor.digest ?? null);
      },
      insert: (tenantId: string, anchor: AnchorRecord) => {
        inserts += 1;
        anchors.push({ tenantId, anchor });
        return Promise.resolve();
      },
    };

    return new AnchorService(logs, anchorRepository, { now: () => NOW });
  }

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, async () => {
      setTenantContext({ tenantId: 't1', source: 'job' });
      return fn();
    });
  }

  beforeEach(() => {
    anchors = [];
    rowsByDay = { '2026-08-05': [row('01920000-0000-7000-8000-000000000001')] };
    inserts = 0;
  });

  describe('write', () => {
    it('anchors a day against the digest of its rows', async () => {
      const anchor = await inTenant(() => build().write('2026-08-05'));

      expect(anchor).toEqual({
        day: '2026-08-05',
        rowCount: 1,
        prevDigest: null,
        digest: computeDigest(rowsByDay['2026-08-05'] ?? [], null),
      });
    });

    it('is idempotent — a re-run writes nothing', async () => {
      // ADR-0010 makes every processor idempotent; BullMQ is at-least-once, and
      // a second anchor row for one day would violate the unique index anyway.
      const service = build();
      const first = await inTenant(() => service.write('2026-08-05'));
      const second = await inTenant(() => service.write('2026-08-05'));

      expect(second).toEqual(first);
      expect(inserts).toBe(1);
    });

    it('back-fills a skipped day onto the anchor that actually precedes it', async () => {
      // §9: the job missed the 5th. Chaining to "yesterday" would find nothing
      // and silently restart the chain; chaining to the newest earlier anchor
      // keeps it continuous across the gap.
      rowsByDay['2026-08-04'] = [row('01920000-0000-7000-8000-00000000000a')];
      const service = build();
      const fourth = await inTenant(() => service.write('2026-08-04'));
      const fifth = await inTenant(() => service.write('2026-08-05'));

      expect(fifth.prevDigest).toBe(fourth.digest);
    });

    it('anchors an empty day rather than skipping it', async () => {
      const anchor = await inTenant(() => build().write('2026-08-03'));
      expect(anchor.rowCount).toBe(0);
      expect(anchor.digest).toEqual(expect.any(String));
    });
  });

  describe('verify', () => {
    it('confirms an untouched day', async () => {
      const service = build();
      await inTenant(() => service.write('2026-08-05'));

      const result = await inTenant(() => service.verify('2026-08-05'));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toMatchObject({ day: '2026-08-05', verified: true, rowCount: 1 });
    });

    it('catches an edited row', async () => {
      const service = build();
      await inTenant(() => service.write('2026-08-05'));
      // What a superuser bypassing the BR-AUD-001 revoke would look like.
      rowsByDay['2026-08-05'] = [
        row('01920000-0000-7000-8000-000000000001', { action: 'nothing.happened' }),
      ];

      const result = await inTenant(() => service.verify('2026-08-05'));
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.verified).toBe(false);
    });

    it('catches a deleted row', async () => {
      const service = build();
      await inTenant(() => service.write('2026-08-05'));
      rowsByDay['2026-08-05'] = [];

      const result = await inTenant(() => service.verify('2026-08-05'));
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toMatchObject({ verified: false, rowCount: 0 });
    });

    it('answers 404 for a day with no anchor', async () => {
      const result = await inTenant(() => build().verify('2026-08-05'));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      // A future day or a day before the tenant existed — not a manufactured
      // "unverifiable" verdict (§7).
      expect(result.error.code).toBe('SYS_NOT_FOUND');
    });

    it('rejects today and later — the day is still accumulating rows', async () => {
      for (const day of ['2026-08-06', '2026-08-07']) {
        const result = await inTenant(() => build().verify(day));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
      }
    });

    it('calls a malformed day a format error, not an out-of-range one', async () => {
      // The range test is a string comparison, correct for `YYYY-MM-DD` and
      // quietly wrong for anything else: `'banana' <= '2026-08-05'` is false, so
      // without the format check a typo reads as a date-range complaint.
      const result = await inTenant(() => build().verify('banana'));
      if (result.ok) throw new Error('unreachable');
      const entries = result.error.details?.__fieldEntries as { code: string }[] | undefined;
      expect(entries?.map((e) => e.code)).toEqual(['VAL_INVALID_FORMAT']);
    });
  });
});
