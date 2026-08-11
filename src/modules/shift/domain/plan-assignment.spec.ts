import { planAssign, planCancel } from './plan-assignment';
import type { AssignmentRow } from './shift.types';

function row(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: 'assign-1',
    companyId: 'co-1',
    employeeId: 'emp-1',
    patternId: 'pat-1',
    cycleAnchorDate: '2026-01-01',
    note: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    ...overrides,
  };
}

const request = {
  companyId: 'co-1',
  employeeId: 'emp-1',
  patternId: 'pat-2',
  effectiveFrom: '2026-09-14',
  cycleAnchorDate: '2026-09-14',
  note: null,
};

describe('BR-SHF-007 — planAssign', () => {
  it('closes the live row at the new date and opens the successor', () => {
    const plan = planAssign([row()], request, '2025-01-01');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.close).toEqual({ id: 'assign-1', effectiveTo: '2026-09-14' });
    expect(plan.value.insert).toMatchObject({
      patternId: 'pat-2',
      effectiveFrom: '2026-09-14',
      effectiveTo: null,
    });
  });

  it('opens an unbounded row when the employee has no arrangement yet', () => {
    const plan = planAssign([], request, '2025-01-01');
    if (plan.ok) expect(plan.value.close).toBeNull();
  });

  it('bounds the successor when a future row already exists', () => {
    const plan = planAssign(
      [row(), row({ id: 'assign-2', effectiveFrom: '2026-12-01' })],
      request,
      '2025-01-01',
    );
    if (plan.ok) expect(plan.value.insert.effectiveTo).toBe('2026-12-01');
  });

  it('refuses a start before the employment it schedules', () => {
    const plan = planAssign([], request, '2026-10-01');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('refuses landing exactly on the current row’s own start', () => {
    const plan = planAssign([row({ effectiveFrom: '2026-09-14' })], request, '2025-01-01');
    expect(plan.ok).toBe(false);
  });

  it('refuses an anchor after the range it phases', () => {
    const plan = planAssign([], { ...request, cycleAnchorDate: '2026-09-15' }, null);
    expect(plan.ok).toBe(false);
  });

  it('refuses an anchor more than ten years back — §8’s fat-finger guard', () => {
    const plan = planAssign([], { ...request, cycleAnchorDate: '2010-01-01' }, null);
    expect(plan.ok).toBe(false);
  });

  it('accepts an anchor before the range, which is how two crews run out of phase', () => {
    const plan = planAssign([], { ...request, cycleAnchorDate: '2026-09-11' }, null);
    expect(plan.ok).toBe(true);
  });
});

describe('planCancel — future rows only', () => {
  const today = '2026-09-14';

  it('soft-deletes the future row and reopens its predecessor', () => {
    const current = row({ id: 'assign-1', effectiveTo: '2026-10-01' });
    const scheduled = row({ id: 'assign-2', effectiveFrom: '2026-10-01', effectiveTo: null });

    const plan = planCancel([current, scheduled], scheduled, today);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.value).toEqual({
        softDelete: 'assign-2',
        reopen: { id: 'assign-1', effectiveTo: null },
      });
    }
  });

  it('refuses a row that has already started', () => {
    const plan = planCancel([row()], row({ effectiveFrom: '2026-09-14' }), today);
    expect(plan.ok).toBe(false);
  });

  it('cancels a future row with no predecessor', () => {
    const scheduled = row({ id: 'assign-2', effectiveFrom: '2026-10-01' });
    const plan = planCancel([scheduled], scheduled, today);
    if (plan.ok) expect(plan.value.reopen).toBeNull();
  });
});
