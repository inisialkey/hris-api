import {
  dayIndexFor,
  resolveScheduledDay,
  type Arrangement,
  type ResolutionInput,
} from './resolve';
import type { ShiftRow } from './shift.types';

/**
 * §14's golden resolution vectors. The ladder, the cycle, the suppression matrix
 * and `standardMinutes` — the four things every consumer of `ScheduledDay`
 * depends on and none of them can see.
 */

const JAKARTA = { branchId: 'br-1', timezone: 'Asia/Jakarta' };

function shift(overrides: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: 'shift-office',
    companyId: 'co-1',
    code: 'OFFICE',
    name: 'Office',
    startTime: '08:00:00',
    endTime: '17:00:00',
    breakMinutes: 60,
    breakStartTime: null,
    lateToleranceMinutes: 10,
    earlyLeaveToleranceMinutes: 5,
    punchInBeforeMinutes: 60,
    punchOutAfterMinutes: 60,
    color: null,
    ...overrides,
  };
}

const OFFICE = shift();
const SHORT = shift({
  id: 'shift-short',
  code: 'SHORT',
  startTime: '08:00:00',
  endTime: '13:00:00',
  breakMinutes: 0,
});
const SHIFTS = new Map([
  [OFFICE.id, OFFICE],
  [SHORT.id, SHORT],
]);

function arrangement(overrides: Partial<Arrangement> = {}): Arrangement {
  return {
    source: 'pattern',
    patternId: 'pat-1',
    patternCode: '5-2',
    cycleLength: 7,
    observesHolidays: true,
    cycleAnchorDate: '2026-09-14', // a Monday
    days: [
      { dayIndex: 0, shiftId: OFFICE.id },
      { dayIndex: 1, shiftId: OFFICE.id },
      { dayIndex: 2, shiftId: OFFICE.id },
      { dayIndex: 3, shiftId: OFFICE.id },
      { dayIndex: 4, shiftId: OFFICE.id },
      { dayIndex: 5, shiftId: SHORT.id },
      { dayIndex: 6, shiftId: null },
    ],
    ...overrides,
  };
}

function resolve(overrides: Partial<ResolutionInput> = {}) {
  return resolveScheduledDay({
    date: '2026-09-14',
    placement: JAKARTA,
    shiftsById: SHIFTS,
    ...overrides,
  });
}

describe('BR-SHF-002 — the ladder', () => {
  it('an explicit row beats the pattern', () => {
    const day = resolve({
      arrangement: arrangement(),
      explicit: { rosterDayId: 'rd-1', shiftId: SHORT.id, worksOnHoliday: false },
    });
    expect(day).toMatchObject({ kind: 'work', source: 'explicit' });
    expect(day.shift?.code).toBe('SHORT');
  });

  it('an explicit row with no shift is a deliberate day off', () => {
    const day = resolve({
      arrangement: arrangement(),
      explicit: { rosterDayId: 'rd-1', shiftId: null, worksOnHoliday: false },
    });
    expect(day).toMatchObject({
      kind: 'off',
      source: 'explicit',
      offReason: 'day_off',
      standardMinutes: 0,
    });
  });

  it('the employee’s pattern beats the company default', () => {
    const day = resolve({ arrangement: arrangement({ source: 'pattern' }) });
    expect(day.source).toBe('pattern');
  });

  it('the company default answers when the employee has no arrangement', () => {
    const day = resolve({ arrangement: arrangement({ source: 'default' }) });
    expect(day).toMatchObject({ kind: 'work', source: 'default' });
  });

  it('nothing at all resolves to unscheduled, not to absent', () => {
    expect(resolve()).toEqual({
      date: '2026-09-14',
      kind: 'off',
      source: 'none',
      offReason: 'unscheduled',
      standardMinutes: 0,
    });
  });

  it('clearing the explicit row falls back to the pattern', () => {
    const withRow = resolve({
      arrangement: arrangement(),
      explicit: { rosterDayId: 'rd-1', shiftId: null, worksOnHoliday: false },
    });
    const cleared = resolve({ arrangement: arrangement() });
    expect(withRow.kind).toBe('off');
    expect(cleared).toMatchObject({ kind: 'work', source: 'pattern' });
  });
});

describe('BR-SHF-003 — cycle math', () => {
  it('indexes from the anchor', () => {
    const cycle = { cycleAnchorDate: '2026-09-14', cycleLength: 7 };
    expect(dayIndexFor(cycle, '2026-09-14')).toBe(0);
    expect(dayIndexFor(cycle, '2026-09-20')).toBe(6);
    expect(dayIndexFor(cycle, '2026-09-21')).toBe(0);
  });

  it('counts backwards through a date before the anchor', () => {
    expect(dayIndexFor({ cycleAnchorDate: '2026-09-14', cycleLength: 7 }, '2026-09-13')).toBe(6);
    expect(dayIndexFor({ cycleAnchorDate: '2026-09-14', cycleLength: 7 }, '2026-09-07')).toBe(0);
  });

  it('does not drift a year past the anchor', () => {
    expect(dayIndexFor({ cycleAnchorDate: '2026-09-14', cycleLength: 7 }, '2027-09-13')).toBe(
      364 % 7,
    );
  });

  it('a one-day cycle repeats forever', () => {
    expect(dayIndexFor({ cycleAnchorDate: '2026-01-01', cycleLength: 1 }, '2026-12-31')).toBe(0);
  });

  it('a 21-day rotation lands on its own phase', () => {
    expect(dayIndexFor({ cycleAnchorDate: '2026-01-01', cycleLength: 21 }, '2026-01-25')).toBe(3);
  });

  it('two crews run the same pattern out of phase', () => {
    const crewA = arrangement({ cycleAnchorDate: '2026-09-14' });
    const crewB = arrangement({ cycleAnchorDate: '2026-09-17' });
    const date = '2026-09-20'; // index 6 for A (OFF), index 3 for B (work)
    expect(resolve({ date, arrangement: crewA }).kind).toBe('off');
    expect(resolve({ date, arrangement: crewB }).kind).toBe('work');
  });

  it('a leap day is just another day', () => {
    expect(dayIndexFor({ cycleAnchorDate: '2028-02-28', cycleLength: 7 }, '2028-03-01')).toBe(2);
  });
});

describe('BR-SHF-004 — holiday suppression', () => {
  const holiday = { kind: 'national' as const, name: 'National day A' };

  it('observes × holiday × not flagged → off/holiday, and the day keeps its standard minutes', () => {
    const day = resolve({ arrangement: arrangement({ observesHolidays: true }), holiday });
    expect(day).toMatchObject({
      kind: 'off',
      offReason: 'holiday',
      standardMinutes: 480,
      holiday,
    });
    expect(day.shift).toBeUndefined();
  });

  it('observes × holiday × works_on_holiday → work, with the holiday still attached', () => {
    const day = resolve({
      arrangement: arrangement({ observesHolidays: true }),
      explicit: { rosterDayId: 'rd-1', shiftId: OFFICE.id, worksOnHoliday: true },
      holiday,
    });
    expect(day).toMatchObject({ kind: 'work', source: 'explicit', holiday });
  });

  it('does not observe × holiday → ordinary work, holiday attached', () => {
    const day = resolve({ arrangement: arrangement({ observesHolidays: false }), holiday });
    expect(day).toMatchObject({ kind: 'work', holiday });
  });

  it('observes × no holiday → work', () => {
    expect(resolve({ arrangement: arrangement({ observesHolidays: true }) }).kind).toBe('work');
  });

  it('no arrangement + explicit row + holiday → suppressed, because the default is to observe', () => {
    const day = resolve({
      explicit: { rosterDayId: 'rd-1', shiftId: OFFICE.id, worksOnHoliday: false },
      holiday,
    });
    expect(day).toMatchObject({ kind: 'off', source: 'explicit', offReason: 'holiday' });
  });

  it('a pattern OFF entry on a holiday stays a plain day off with zero standard minutes', () => {
    const day = resolve({ date: '2026-09-20', arrangement: arrangement(), holiday });
    expect(day).toMatchObject({ kind: 'off', offReason: 'holiday', standardMinutes: 0 });
  });

  it('a negated holiday never reaches here — no holiday argument means work', () => {
    // holiday.md resolves `observed = false` to a working day, so the port
    // returns nothing and this module has no second opinion to form.
    expect(resolve({ arrangement: arrangement() }).kind).toBe('work');
  });
});

describe('§4.3 — standardMinutes', () => {
  it('equals the shift’s paid minutes on a worked day', () => {
    expect(resolve({ arrangement: arrangement() }).standardMinutes).toBe(480);
  });

  it('survives suppression on a short day — overtime.md BR-OVT-010’s boundary', () => {
    // The six-day arrangement's short Saturday: a holiday landing on it schedules
    // 300 minutes, not 480, and pricing it as 480 overpays by three hours.
    const day = resolve({
      date: '2026-09-19',
      arrangement: arrangement(),
      holiday: { kind: 'national', name: 'National day A' },
    });
    expect(day).toMatchObject({ offReason: 'holiday', standardMinutes: 300 });
  });

  it('is 0 on an explicit day off, an unscheduled employee and an unplaced one', () => {
    expect(
      resolve({
        arrangement: arrangement(),
        explicit: { rosterDayId: 'rd-1', shiftId: null, worksOnHoliday: false },
      }).standardMinutes,
    ).toBe(0);
    expect(resolve().standardMinutes).toBe(0);
    expect(resolve({ arrangement: arrangement(), placement: null }).standardMinutes).toBe(0);
  });
});

describe('BR-SHF-008 — placement', () => {
  it('an unplaced employee resolves off/unplaced rather than a guessed timezone', () => {
    expect(resolve({ arrangement: arrangement(), placement: null })).toMatchObject({
      kind: 'off',
      offReason: 'unplaced',
      source: 'pattern',
    });
  });

  it('resolves instants in the branch’s zone', () => {
    const jakarta = resolve({ arrangement: arrangement() });
    const jayapura = resolve({
      arrangement: arrangement(),
      placement: { branchId: 'br-2', timezone: 'Asia/Jayapura' },
    });
    expect(jakarta.shift?.startAt).toBe('2026-09-14T01:00:00.000Z');
    expect(jayapura.shift?.startAt).toBe('2026-09-13T23:00:00.000Z');
  });
});

describe('BR-SHF-005 — the working day is the start date', () => {
  const NIGHT = shift({
    id: 'shift-night',
    code: 'NIGHT',
    startTime: '22:00:00',
    endTime: '06:00:00',
    breakMinutes: 30,
  });

  it('a night shift’s window ends after the following midnight, on the start date’s row', () => {
    const day = resolveScheduledDay({
      date: '2026-09-14',
      placement: JAKARTA,
      shiftsById: new Map([[NIGHT.id, NIGHT]]),
      arrangement: arrangement({
        cycleLength: 1,
        days: [{ dayIndex: 0, shiftId: NIGHT.id }],
        cycleAnchorDate: '2026-09-14',
      }),
    });
    expect(day.shift).toMatchObject({
      startAt: '2026-09-14T15:00:00.000Z',
      endAt: '2026-09-14T23:00:00.000Z',
      windowTo: '2026-09-15T00:00:00.000Z',
      paidMinutes: 450,
    });
  });
});
