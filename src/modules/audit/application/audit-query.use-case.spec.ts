import type { AuditLogFilter, AuditLogRow, KeysetCursor } from '../domain/audit.ports';
import { AuditQueryUseCase } from './audit-query.use-case';

/** UC-AUD-004, and BR-AUD-007's recursive case: reading the log is a logged read. */
describe('AuditQueryUseCase', () => {
  let stored: AuditLogRow[];
  let seenFilter: AuditLogFilter | null;
  let seenPage: { limit: number; after?: KeysetCursor } | null;
  let reads: { action: string; entityId?: string; metadata?: Record<string, unknown> }[];
  /** The order the two statements ran in — the assertion of this suite. */
  let trace: string[];

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
      entityId: null,
      diff: null,
      metadata: null,
      eventId: null,
      ...over,
    };
  }

  function build(): AuditQueryUseCase {
    const repository = {
      append: () => Promise.resolve('unused'),
      findById: (id: string) => {
        trace.push('read');
        return Promise.resolve(stored.find((r) => r.id === id) ?? null);
      },
      list: (filter: AuditLogFilter, page: { limit: number; after?: KeysetCursor }) => {
        trace.push('read');
        seenFilter = filter;
        seenPage = page;
        return Promise.resolve({
          rows: stored.slice(0, page.limit),
          hasMore: stored.length > page.limit,
        });
      },
      listForAnchorDay: () => Promise.resolve([]),
    };

    const audit = {
      sensitiveRead: (
        action: string,
        _entityType: string,
        entityId?: string,
        metadata?: Record<string, unknown>,
      ) => {
        trace.push('audit');
        reads.push({ action, entityId, metadata });
        return Promise.resolve();
      },
    };

    return new AuditQueryUseCase(repository, audit);
  }

  beforeEach(() => {
    stored = [row()];
    seenFilter = null;
    seenPage = null;
    reads = [];
    trace = [];
  });

  it('audits every list call with the filters, never the results', async () => {
    const result = await build().list({ entityType: 'holidays', actorUserId: 'u1' }, { limit: 20 });

    expect(result.ok).toBe(true);
    expect(reads).toEqual([
      {
        action: 'audit.log.queried',
        entityId: undefined,
        metadata: { filters: { entityType: 'holidays', actorUserId: 'u1' }, limit: 20 },
      },
    ]);
    // Copying result rows into `metadata` would put the very content this log
    // protects into a second, unmasked place (§4.3).
    expect(JSON.stringify(reads[0]?.metadata)).not.toContain('holidays.updated');
  });

  it('reads before it audits, so a query never returns its own row', async () => {
    await build().list({}, { limit: 20 });
    expect(trace).toEqual(['read', 'audit']);
  });

  it('serialises date filters as ISO strings for jsonb', async () => {
    await build().list(
      { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-05T00:00:00Z') },
      { limit: 20 },
    );
    const filters = reads[0]?.metadata?.filters as Record<string, unknown>;
    expect(filters.from).toBe('2026-08-01T00:00:00.000Z');
    expect(filters.to).toBe('2026-08-05T00:00:00.000Z');
  });

  it('refuses an inverted range before it becomes a query returning nothing', async () => {
    const result = await build().list(
      { from: new Date('2026-08-05T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') },
      { limit: 20 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
    // And nothing was read or audited — a rejected request is not an access.
    expect(trace).toEqual([]);
  });

  it('refuses an empty range too — `[from, to)` is half-open', async () => {
    const instant = new Date('2026-08-05T00:00:00Z');
    const result = await build().list({ from: instant, to: instant }, { limit: 20 });
    expect(result.ok).toBe(false);
  });

  it('passes the keyset position through untouched', async () => {
    const after = { occurredAt: new Date('2026-08-05T09:00:00Z'), id: 'c1' };
    await build().list({}, { limit: 5, after });
    expect(seenPage).toEqual({ limit: 5, after });
    expect(seenFilter).toEqual({});
  });

  it('audits a detail read against the row it revealed', async () => {
    const result = await build().detail('01920000-0000-7000-8000-000000000001');

    expect(result.ok).toBe(true);
    expect(reads[0]).toMatchObject({
      action: 'audit.log.queried',
      entityId: '01920000-0000-7000-8000-000000000001',
    });
  });

  it('answers a miss with SYS_NOT_FOUND and audits nothing', async () => {
    const result = await build().detail('01920000-0000-7000-8000-0000000000ff');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Existence hiding: a row in another tenant is invisible to RLS, so the miss
    // and the denial are the same answer (error-catalog §2).
    expect(result.error.code).toBe('SYS_NOT_FOUND');
    expect(reads).toEqual([]);
  });
});
