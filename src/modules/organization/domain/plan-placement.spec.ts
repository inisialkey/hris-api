import { FIELD_ENTRIES } from '../../../shared/validation-details';
import type { AssignmentRow } from './organization.types';
import { planCancel, planMove } from './plan-placement';

const JOIN_DATE = '2026-01-01';

function row(
  overrides: Partial<AssignmentRow> & { id: string; effectiveFrom: string },
): AssignmentRow {
  return {
    employeeId: 'emp-1',
    positionId: 'pos-old',
    branchId: 'br-old',
    kind: 'hire',
    note: null,
    effectiveTo: null,
    ...overrides,
  };
}

function move(effectiveFrom: string, kind: AssignmentRow['kind'] = 'transfer') {
  return { positionId: 'pos-new', branchId: 'br-new', kind, effectiveFrom };
}

function fieldEntries(error: { details?: Record<string, unknown> }) {
  return error.details?.[FIELD_ENTRIES] as { field: string; params?: Record<string, unknown> }[];
}

describe('planMove', () => {
  it('seeds the first placement with nothing to close', () => {
    const plan = planMove([], move(JOIN_DATE, 'hire'), JOIN_DATE);

    expect(plan).toEqual({
      ok: true,
      value: {
        close: null,
        insert: {
          positionId: 'pos-new',
          branchId: 'br-new',
          kind: 'hire',
          note: null,
          effectiveFrom: JOIN_DATE,
          effectiveTo: null,
        },
      },
    });
  });

  it('closes the live row at the new date and opens the successor there', () => {
    const rows = [row({ id: 'a', effectiveFrom: JOIN_DATE })];

    const plan = planMove(rows, move('2026-06-01'), JOIN_DATE);

    expect(plan.ok && plan.value.close).toEqual({ id: 'a', effectiveTo: '2026-06-01' });
    expect(plan.ok && plan.value.insert.effectiveFrom).toBe('2026-06-01');
    expect(plan.ok && plan.value.insert.effectiveTo).toBeNull();
  });

  it('schedules a future move against the row that is live today', () => {
    const rows = [row({ id: 'a', effectiveFrom: JOIN_DATE })];

    const plan = planMove(rows, move('2026-12-01'), JOIN_DATE);

    // BR-ORG-008: the current row's `effective_to` closes at the future date
    // immediately — the timeline is written now, it just applies later.
    expect(plan.ok && plan.value.close).toEqual({ id: 'a', effectiveTo: '2026-12-01' });
  });

  it('supersedes the scheduled row when the new move lands after it', () => {
    const rows = [
      row({ id: 'a', effectiveFrom: JOIN_DATE, effectiveTo: '2026-09-01' }),
      row({ id: 'b', effectiveFrom: '2026-09-01' }),
    ];

    const plan = planMove(rows, move('2026-10-01'), JOIN_DATE);

    expect(plan.ok && plan.value.close).toEqual({ id: 'b', effectiveTo: '2026-10-01' });
  });

  it('lands a backdated correction inside the interval it corrects, not across it', () => {
    const rows = [
      row({ id: 'a', effectiveFrom: JOIN_DATE, effectiveTo: '2026-06-01' }),
      row({ id: 'b', effectiveFrom: '2026-06-01' }),
    ];

    const plan = planMove(rows, move('2026-03-01', 'correction'), JOIN_DATE);

    expect(plan.ok && plan.value.close).toEqual({ id: 'a', effectiveTo: '2026-03-01' });
    // Inherits a's old end: the correction stops where b already begins, so the
    // exclusion constraint has nothing to refuse.
    expect(plan.ok && plan.value.insert.effectiveTo).toBe('2026-06-01');
  });

  it('fills a gap without swallowing the placement that follows it', () => {
    const rows = [row({ id: 'b', effectiveFrom: '2026-06-01' })];

    const plan = planMove(rows, move('2026-03-01', 'correction'), JOIN_DATE);

    expect(plan.ok && plan.value.close).toBeNull();
    expect(plan.ok && plan.value.insert.effectiveTo).toBe('2026-06-01');
  });

  it('refuses a placement that starts before the employee did', () => {
    const plan = planMove([], move('2025-12-31'), JOIN_DATE);

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(!plan.ok && fieldEntries(plan.error)[0]).toMatchObject({
      field: 'effectiveFrom',
      params: { min: JOIN_DATE },
    });
  });

  it('refuses a move effective on the day the current row began', () => {
    const rows = [row({ id: 'a', effectiveFrom: '2026-06-01' })];

    const plan = planMove(rows, move('2026-06-01'), JOIN_DATE);

    expect(plan.ok).toBe(false);
    expect(!plan.ok && fieldEntries(plan.error)[0]).toMatchObject({
      field: 'effectiveFrom',
      params: { min: '2026-06-02' },
    });
  });

  it('lets adjacent ranges share a boundary date', () => {
    const rows = [row({ id: 'a', effectiveFrom: JOIN_DATE, effectiveTo: '2026-06-01' })];

    // The date b already starts on is open ground once a is closed there.
    const plan = planMove(rows, move('2026-06-01'), JOIN_DATE);

    expect(plan.ok && plan.value.close).toBeNull();
    expect(plan.ok && plan.value.insert.effectiveFrom).toBe('2026-06-01');
  });
});

describe('planCancel', () => {
  const TODAY = '2026-08-06';

  it('soft-deletes the scheduled row and reopens its predecessor', () => {
    const scheduled = row({ id: 'b', effectiveFrom: '2026-09-01' });
    const rows = [row({ id: 'a', effectiveFrom: JOIN_DATE, effectiveTo: '2026-09-01' }), scheduled];

    const plan = planCancel(rows, scheduled, TODAY);

    expect(plan).toEqual({
      ok: true,
      value: { softDelete: 'b', reopen: { id: 'a', effectiveTo: null } },
    });
  });

  it('gives the predecessor back exactly what the cancelled row was covering', () => {
    const scheduled = row({ id: 'b', effectiveFrom: '2026-09-01', effectiveTo: '2026-11-01' });
    const rows = [
      row({ id: 'a', effectiveFrom: JOIN_DATE, effectiveTo: '2026-09-01' }),
      scheduled,
      row({ id: 'c', effectiveFrom: '2026-11-01' }),
    ];

    const plan = planCancel(rows, scheduled, TODAY);

    expect(plan.ok && plan.value.reopen).toEqual({ id: 'a', effectiveTo: '2026-11-01' });
  });

  it('refuses to cancel the row in effect today', () => {
    const current = row({ id: 'a', effectiveFrom: TODAY });

    const plan = planCancel([current], current, TODAY);

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('refuses to cancel history', () => {
    const past = row({ id: 'a', effectiveFrom: JOIN_DATE });

    expect(planCancel([past], past, TODAY).ok).toBe(false);
  });

  it('cancels a lone scheduled row with nothing to reopen', () => {
    const scheduled = row({ id: 'b', effectiveFrom: '2026-09-01' });

    const plan = planCancel([scheduled], scheduled, TODAY);

    expect(plan.ok && plan.value.reopen).toBeNull();
  });
});
