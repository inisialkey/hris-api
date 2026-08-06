import { planCancel, planWrite } from './plan-write';
import type { SettingDefinition, SettingValueRow } from './setting.types';

/** UC-SET-002/003/004 as arithmetic on a date axis — no state machine, §4.1. */
describe('planWrite', () => {
  const TODAY = '2026-08-06';

  function definition(over: Partial<SettingDefinition> = {}): SettingDefinition {
    return {
      key: 'tax.method',
      module: 'tax',
      type: 'enum',
      allowedLevels: ['tenant', 'company'],
      defaultValue: 'gross',
      validation: { enum: ['gross', 'gross_up'] },
      effectiveDated: true,
      clientVisible: false,
      description: 'Withholding method',
      ...over,
    };
  }

  function row(over: Partial<SettingValueRow>): SettingValueRow {
    return {
      id: 'v1',
      key: 'tax.method',
      level: 'tenant',
      companyId: null,
      branchId: null,
      value: 'gross',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      ...over,
    };
  }

  const request = {
    level: 'tenant' as const,
    value: 'gross_up',
    effectiveFrom: TODAY,
  };

  it('opens the first row when nothing exists', () => {
    const result = planWrite(definition(), [], request, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      action: 'set',
      close: null,
      drop: null,
      insert: { value: 'gross_up', effectiveFrom: TODAY, effectiveTo: null },
    });
  });

  it('closes the live row at today and opens the successor (UC-SET-002)', () => {
    const result = planWrite(definition(), [row({ id: 'live' })], request, TODAY);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      action: 'set',
      close: { id: 'live', effectiveTo: TODAY },
      drop: null,
      insert: { value: 'gross_up', effectiveFrom: TODAY, effectiveTo: null },
    });
  });

  it('drops a row written earlier the same day instead of closing it to nothing', () => {
    // `[today, today)` is an empty interval: the exclusion constraint ignores it
    // and the history list shows a row that was never in effect for a day.
    // History granularity is a day, so the second write of the day *is* the day's
    // row — which is what §14 calls idempotent day granularity.
    const result = planWrite(
      definition(),
      [row({ id: 'earlier', effectiveFrom: TODAY })],
      request,
      TODAY,
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      action: 'set',
      close: null,
      drop: 'earlier',
      insert: { value: 'gross_up', effectiveFrom: TODAY, effectiveTo: null },
    });
  });

  it('schedules a future change and closes the live row at that date (UC-SET-003)', () => {
    const result = planWrite(
      definition(),
      [row({ id: 'live' })],
      { ...request, effectiveFrom: '2026-09-01' },
      TODAY,
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      action: 'scheduled',
      close: { id: 'live', effectiveTo: '2026-09-01' },
      drop: null,
      insert: { value: 'gross_up', effectiveFrom: '2026-09-01', effectiveTo: null },
    });
  });

  it('stops an immediate write short of an existing schedule rather than colliding with it', () => {
    // Setting a value now must not silently cancel a change someone scheduled
    // for next month, and an open-ended row would overlap it — the exclusion
    // constraint would refuse the write with nothing useful to say.
    const rows = [
      row({ id: 'live', effectiveTo: '2026-09-01' }),
      row({ id: 'future', effectiveFrom: '2026-09-01', value: 'gross' }),
    ];
    const result = planWrite(definition(), rows, request, TODAY);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      action: 'set',
      close: { id: 'live', effectiveTo: TODAY },
      drop: null,
      insert: { value: 'gross_up', effectiveFrom: TODAY, effectiveTo: '2026-09-01' },
    });
  });

  it('refuses a second schedule for the same key and scope (BR-SET-006)', () => {
    const rows = [row({ id: 'future', effectiveFrom: '2026-09-01' })];
    const result = planWrite(
      definition(),
      rows,
      { ...request, effectiveFrom: '2026-10-01' },
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SET_SCHEDULE_OVERLAP');
    // The client cancels by id, so the id has to travel with the refusal.
    expect(result.error.details).toEqual({ existingValueId: 'future' });
  });

  it('refuses a level the definition does not allow (BR-SET-002)', () => {
    const result = planWrite(definition(), [], { ...request, level: 'branch' }, TODAY);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SET_LEVEL_NOT_ALLOWED');
    expect(result.error.details).toEqual({ allowedLevels: ['tenant', 'company'] });
  });

  it('refuses a future date on a plain key (BR-SET-003)', () => {
    const result = planWrite(
      definition({ effectiveDated: false }),
      [],
      { ...request, effectiveFrom: '2026-09-01' },
      TODAY,
    );
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SET_NOT_EFFECTIVE_DATED');
  });

  it('accepts today on a plain key — dating is how every value is stored', () => {
    // BR-SET-003: plain keys still write dated rows, they just cannot schedule.
    expect(planWrite(definition({ effectiveDated: false }), [], request, TODAY).ok).toBe(true);
  });

  it('refuses a past date on any key', () => {
    const result = planWrite(definition(), [], { ...request, effectiveFrom: '2026-08-05' }, TODAY);
    if (result.ok) throw new Error('unreachable');
    // Backdating would rewrite what a payroll run already read as-of (BR-SET-004).
    expect(result.error.code).toBe('VAL_VALIDATION_FAILED');
  });
});

describe('planCancel', () => {
  const TODAY = '2026-08-06';

  function row(over: Partial<SettingValueRow>): SettingValueRow {
    return {
      id: 'v1',
      key: 'tax.method',
      level: 'tenant',
      companyId: null,
      branchId: null,
      value: 'gross_up',
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      ...over,
    };
  }

  it('deletes the future row and reopens its predecessor (UC-SET-004)', () => {
    const scheduled = row({ id: 'future' });
    const predecessor = row({
      id: 'live',
      value: 'gross',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-09-01',
    });

    const result = planCancel([predecessor, scheduled], scheduled, TODAY);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ delete: 'future', reopen: 'live' });
  });

  it('cancels a schedule that has no predecessor', () => {
    const scheduled = row({ id: 'future' });
    const result = planCancel([scheduled], scheduled, TODAY);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ delete: 'future', reopen: null });
  });

  it('refuses to cancel a row already in effect (BR-SET-005)', () => {
    const live = row({ id: 'live', effectiveFrom: '2026-01-01' });
    const result = planCancel([live], live, TODAY);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SET_HISTORY_IMMUTABLE');
  });

  it('refuses to cancel a row taking effect today', () => {
    // Today is already being read as-of by every request in flight.
    const live = row({ id: 'today', effectiveFrom: TODAY });
    const result = planCancel([live], live, TODAY);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('SET_HISTORY_IMMUTABLE');
  });
});
