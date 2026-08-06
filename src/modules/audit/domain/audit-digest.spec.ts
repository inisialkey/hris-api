import { anchorDayRange, computeDigest, rowHash } from './audit-digest';
import type { AuditLogRow } from './audit.ports';

/** BR-AUD-009 / UC-AUD-005: the digest is the whole tamper-evidence claim. */
describe('audit digest', () => {
  function row(over: Partial<AuditLogRow> = {}): AuditLogRow {
    return {
      id: '01920000-0000-7000-8000-000000000001',
      occurredAt: new Date('2026-08-05T10:00:00.000Z'),
      actorType: 'user',
      actorUserId: 'u1',
      impersonatorId: null,
      requestId: 'req-1',
      action: 'holidays.updated',
      entityType: 'holidays',
      entityId: '01920000-0000-7000-8000-0000000000aa',
      diff: { changed: { name: { before: 'Idul Fitri', after: 'Idul Fitri (cuti bersama)' } } },
      metadata: null,
      eventId: null,
      ...over,
    };
  }

  describe('anchorDayRange', () => {
    it('brackets the UTC day and meets the next day exactly', () => {
      const day = anchorDayRange('2026-08-05');
      const next = anchorDayRange('2026-08-06');

      expect(day.fromId).toBe('019fcf38-4800-7000-8000-000000000000');
      // Half-open: the upper bound of one day *is* the lower bound of the next,
      // so no insert can fall in both ranges or in neither.
      expect(day.toId).toBe(next.fromId);
    });

    it('places a real uuidv7 inside the range for its own millisecond', () => {
      // The boundary is the smallest legal v7 for that ms — version nibble 7,
      // variant nibble 8, every random bit zero — so any real id sorts above it.
      const { fromId, toId } = anchorDayRange('2026-08-05');
      const real = '019fcf38-4800-7abc-9def-0123456789ab';
      expect(real >= fromId).toBe(true);
      expect(real < toId).toBe(true);
    });

    it('rejects a day that is not an ISO date', () => {
      expect(() => anchorDayRange('banana')).toThrow(/not an ISO date/);
    });
  });

  describe('rowHash', () => {
    it('is stable for identical content', () => {
      expect(rowHash(row())).toBe(rowHash(row()));
    });

    // The point of a digest is that *no* column can be edited unnoticed. A hash
    // covering only the interesting fields certifies the boring ones as forgeable.
    const fields: [string, Partial<AuditLogRow>][] = [
      ['id', { id: '01920000-0000-7000-8000-000000000002' }],
      ['occurredAt', { occurredAt: new Date('2026-08-05T10:00:00.001Z') }],
      ['actorType', { actorType: 'system' }],
      ['actorUserId', { actorUserId: 'u2' }],
      ['impersonatorId', { impersonatorId: 'p1' }],
      ['requestId', { requestId: 'req-2' }],
      ['action', { action: 'holidays.deleted' }],
      ['entityType', { entityType: 'companies' }],
      ['entityId', { entityId: '01920000-0000-7000-8000-0000000000bb' }],
      ['diff', { diff: { changed: { name: { masked: true } } } }],
      ['metadata', { metadata: { ip: '10.0.0.1' } }],
      ['eventId', { eventId: '01920000-0000-7000-8000-0000000000cc' }],
    ];

    it.each(fields)('changes when %s changes', (_field, over) => {
      expect(rowHash(row(over))).not.toBe(rowHash(row()));
    });

    it('ignores jsonb key order', () => {
      // jsonb round-trips in its own key order. Without canonicalisation a dump
      // and restore would report tampering that never happened.
      const a = row({ metadata: { ip: '10.0.0.1', userAgent: 'curl' } });
      const b = row({ metadata: { userAgent: 'curl', ip: '10.0.0.1' } });
      expect(rowHash(a)).toBe(rowHash(b));
    });
  });

  describe('computeDigest', () => {
    it('chains: the same rows under a different predecessor differ', () => {
      expect(computeDigest([row()], 'prev-a')).not.toBe(computeDigest([row()], 'prev-b'));
    });

    it('is order sensitive', () => {
      const a = row({ id: '01920000-0000-7000-8000-000000000001' });
      const b = row({ id: '01920000-0000-7000-8000-000000000002' });
      expect(computeDigest([a, b], null)).not.toBe(computeDigest([b, a], null));
    });

    it('distinguishes an empty day from a missing anchor', () => {
      expect(computeDigest([], null)).toEqual(expect.any(String));
      expect(computeDigest([], null)).not.toBe(computeDigest([row()], null));
    });

    it('cannot be balanced by swapping one row for another', () => {
      // Row count is folded in, so deleting a row and inserting a replacement
      // does not restore the digest even if the count matches again.
      const before = computeDigest(
        [row(), row({ id: '01920000-0000-7000-8000-000000000002' })],
        null,
      );
      const after = computeDigest(
        [row(), row({ id: '01920000-0000-7000-8000-000000000003' })],
        null,
      );
      expect(after).not.toBe(before);
    });
  });
});
