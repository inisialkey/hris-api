import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
  assertAuditedTable,
  buildChangeDiff,
  clearAuditedTables,
  registerAuditedTables,
} from './audited-tables';

/** Stands in for ADR-0016's `encryptedText` — a Drizzle custom type, layer 1's whole signal. */
const encryptedText = customType<{ data: string }>({
  dataType: () => 'text',
});

const widgets = pgTable('widgets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  amount: text('amount'),
  reason: text('reason'),
  npwp: encryptedText('npwp'),
  refreshTokenHash: text('refresh_token_hash'),
  createdAt: timestamp('created_at'),
  updatedBy: uuid('updated_by'),
  deletedAt: timestamp('deleted_at'),
});

beforeEach(() => {
  clearAuditedTables();
});

describe('the §4.2 registry', () => {
  it('refuses an audited table nobody classified', () => {
    expect(() => {
      assertAuditedTable('widgets');
    }).toThrow(/no audit-log §4.2 registry entry/);
  });

  it('accepts a re-registration that agrees and rejects one that does not', () => {
    registerAuditedTables({ widgets: { maskedColumns: ['reason'] } });
    expect(() => {
      registerAuditedTables({ widgets: { maskedColumns: ['reason'] } });
    }).not.toThrow();
    expect(() => {
      registerAuditedTables({ widgets: {} });
    }).toThrow(/different masking note/);
  });
});

describe('BR-AUD-005 masking', () => {
  it('masks an encrypted column with no registry entry naming it (layer 1)', () => {
    registerAuditedTables({ widgets: {} });

    const diff = buildChangeDiff(widgets, 'updated', { npwp: 'before' }, { npwp: 'after' });

    expect(diff.changed.npwp).toEqual({ masked: true });
  });

  it('masks token material whatever the table note says (layer 2)', () => {
    registerAuditedTables({ widgets: {} });

    const diff = buildChangeDiff(
      widgets,
      'updated',
      { refreshTokenHash: 'old' },
      { refreshTokenHash: 'new' },
    );

    expect(diff.changed.refresh_token_hash).toEqual({ masked: true });
  });

  it('masks what the table registered and nothing else (layer 3)', () => {
    registerAuditedTables({ widgets: { maskedColumns: ['reason'] } });

    const diff = buildChangeDiff(
      widgets,
      'updated',
      { reason: 'flu', name: 'old' },
      { reason: 'fever', name: 'new' },
    );

    expect(diff.changed.reason).toEqual({ masked: true });
    expect(diff.changed.name).toEqual({ before: 'old', after: 'new' });
  });

  it('diffs money in full — the amount is the fact being attested to', () => {
    registerAuditedTables({ widgets: {} });

    const diff = buildChangeDiff(widgets, 'updated', { amount: '1000' }, { amount: '2000' });

    expect(diff.changed.amount).toEqual({ before: '1000', after: '2000' });
  });
});

describe('the diff itself', () => {
  beforeEach(() => {
    registerAuditedTables({ widgets: {} });
  });

  it('carries the after side on created and the before side on deleted', () => {
    const created = buildChangeDiff(widgets, 'created', undefined, { name: 'first' });
    expect(created.changed.name).toEqual({ before: null, after: 'first' });

    const deleted = buildChangeDiff(widgets, 'deleted', { name: 'first' }, undefined);
    expect(deleted.changed.name).toEqual({ before: 'first', after: null });
  });

  it('names only the columns an update actually moved', () => {
    const diff = buildChangeDiff(
      widgets,
      'updated',
      { name: 'same', reason: 'old' },
      { name: 'same', reason: 'new' },
    );

    expect(Object.keys(diff.changed)).toEqual(['reason']);
  });

  it('leaves out what the audit row already says more precisely', () => {
    const diff = buildChangeDiff(widgets, 'created', undefined, {
      id: 'row-id',
      tenantId: 'tenant-id',
      name: 'first',
      createdAt: new Date('2026-08-06T00:00:00Z'),
      updatedBy: 'user-id',
      deletedAt: null,
    });

    expect(Object.keys(diff.changed)).toEqual(['name']);
  });

  it('does not call a column changed because jsonb reordered it or a date was reparsed', () => {
    const at = new Date('2026-08-06T00:00:00Z');
    const diff = buildChangeDiff(
      widgets,
      'updated',
      { name: 'same', createdAt: at },
      { name: 'same', createdAt: new Date(at.toISOString()) },
    );

    expect(diff.changed).toEqual({});
  });
});
