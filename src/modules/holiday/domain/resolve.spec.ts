import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDate, resolveRange, resolvedCalendar, type ResolvableRow } from './resolve';
import type { DayType, HolidayScope } from './holiday.types';

/**
 * ADR-0018 decision 7: the vectors live in the handbook because two
 * implementations consume them, and they are **read from the submodule in
 * place** — not vendored, not hashed (ADR-0025 amended that clause). A drifting
 * copy is the failure the pin already prevents.
 *
 * Decision 2 binds the reader as much as the file: a failing vector is a defect
 * in this reducer until a human re-verifies the vector against holiday.md and
 * records why it changed.
 */
interface Vector {
  name: string;
  source: string;
  input: { scope: HolidayScope; date: string; rows: ResolvableRow[] };
  expected: DayType;
}

const vectors = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../docs/handbook/docs/07-operations/test-vectors/holiday-resolution.json',
    ),
    'utf8',
  ),
) as { vectors: Vector[] };

describe('holiday resolution — handbook golden vectors (BR-HOL-002)', () => {
  it.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(resolveDate(vector.input.rows, vector.input.scope, vector.input.date)).toEqual(
        vector.expected,
      );
    },
  );

  it('covers every scenario the file ships', () => {
    // A vector file nobody counts is a vector file somebody can shorten.
    expect(vectors.vectors).toHaveLength(14);
  });
});

const SCOPE: HolidayScope = { companyId: 'c1', branchId: 'b1' };

function row(overrides: Partial<ResolvableRow> = {}): ResolvableRow {
  return {
    companyId: null,
    branchId: null,
    date: '2026-05-01',
    name: 'National day A',
    kind: 'national',
    observed: true,
    ...overrides,
  };
}

describe('resolveRange', () => {
  it('returns one entry per non-working kind, ascending by date', () => {
    const rows = [
      row({ date: '2026-05-04', kind: 'custom', name: 'Company day' }),
      row({ date: '2026-05-01' }),
      row({ date: '2026-05-01', kind: 'cuti_bersama', name: 'Cuti bersama A' }),
    ];
    expect(resolveRange(rows, SCOPE, '2026-05-01', '2026-06-01')).toEqual([
      { date: '2026-05-01', kind: 'national', name: 'National day A' },
      { date: '2026-05-01', kind: 'cuti_bersama', name: 'Cuti bersama A' },
      { date: '2026-05-04', kind: 'custom', name: 'Company day' },
    ]);
  });

  it('is half-open — `to` is excluded', () => {
    const rows = [row({ date: '2026-05-31' }), row({ date: '2026-06-01' })];
    expect(resolveRange(rows, SCOPE, '2026-05-01', '2026-06-01').map((d) => d.date)).toEqual([
      '2026-05-31',
    ]);
  });

  it('omits a date whose only row is negated', () => {
    const rows = [row(), row({ companyId: 'c1', observed: false })];
    expect(resolveRange(rows, SCOPE, '2026-01-01', '2027-01-01')).toEqual([]);
  });

  it('ignores rows belonging to another company', () => {
    const rows = [row({ companyId: 'c9', kind: 'custom', name: 'Their day' })];
    expect(resolveRange(rows, SCOPE, '2026-01-01', '2027-01-01')).toEqual([]);
  });
});

describe('resolvedCalendar — §7 /resolved', () => {
  it('lists a negated day with the scope that negated it', () => {
    const rows = [row(), row({ companyId: 'c1', observed: false })];
    expect(resolvedCalendar(rows, SCOPE)).toEqual([
      { date: '2026-05-01', kind: 'national', name: 'National day A', negatedAtScope: 'company' },
    ]);
  });

  it('marks a branch negation as `branch`', () => {
    const rows = [row(), row({ companyId: 'c1', branchId: 'b1', observed: false })];
    expect(resolvedCalendar(rows, SCOPE)[0]?.negatedAtScope).toBe('branch');
  });

  it('names a negated entry after the day it cancels, not after the negation row', () => {
    const rows = [
      row({ name: 'National day A' }),
      row({ companyId: 'c1', observed: false, name: 'we work this one' }),
    ];
    expect(resolvedCalendar(rows, SCOPE)[0]?.name).toBe('National day A');
  });

  it('falls back to the negation’s own name when its target is gone (§9 orphan)', () => {
    const rows = [row({ companyId: 'c1', observed: false, name: 'orphan' })];
    expect(resolvedCalendar(rows, SCOPE)).toEqual([
      { date: '2026-05-01', kind: 'national', name: 'orphan', negatedAtScope: 'company' },
    ]);
  });

  it('orders kinds by display priority within a date', () => {
    const rows = [
      row({ kind: 'custom', name: 'Company day' }),
      row({ kind: 'cuti_bersama', name: 'Cuti bersama A' }),
      row({ kind: 'national' }),
    ];
    expect(resolvedCalendar(rows, SCOPE).map((day) => day.kind)).toEqual([
      'national',
      'cuti_bersama',
      'custom',
    ]);
  });
});
