import { crossesMidnight, instantsFor, paidMinutes, spanMinutes, windowMinutes } from './time';

/**
 * §4.3's worked examples, asserted exactly as the table prints them — branch
 * `Asia/Jakarta`, roster date 2026-09-14. They are the arithmetic every consumer
 * computes against: attendance matches a punch to `windowFrom`/`windowTo`,
 * overtime's baseline is `endAt`, and payroll reads paid minutes through
 * attendance's derived day.
 */
const JAKARTA = 'Asia/Jakarta';
const DATE = '2026-09-14';

const office = {
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};
const night = {
  startTime: '22:00:00',
  endTime: '06:00:00',
  breakMinutes: 30,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};
const morning = {
  startTime: '06:00:00',
  endTime: '14:00:00',
  breakMinutes: 45,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};

describe('§4.3 — span and paid minutes', () => {
  it('office: 540 / 480', () => {
    expect(spanMinutes(office)).toBe(540);
    expect(paidMinutes(office)).toBe(480);
  });

  it('night: 480 / 450, and it crosses midnight', () => {
    expect(spanMinutes(night)).toBe(480);
    expect(paidMinutes(night)).toBe(450);
    expect(crossesMidnight(night)).toBe(true);
  });

  it('morning: 480 / 435, no crossing', () => {
    expect(spanMinutes(morning)).toBe(480);
    expect(paidMinutes(morning)).toBe(435);
    expect(crossesMidnight(morning)).toBe(false);
  });

  it('a 24-hour shift is impossible: equal times are refused by BR-SHF-001’s CHECK', () => {
    // The arithmetic would report 0, which is why the database refuses the row
    // rather than leaving the resolver to invent a meaning for it.
    expect(spanMinutes({ startTime: '08:00:00', endTime: '08:00:00' })).toBe(0);
  });
});

describe('§4.3 — instants in a branch timezone', () => {
  it('office 08:00–17:00 → 01:00Z → 10:00Z, window 00:00Z → 11:00Z', () => {
    expect(instantsFor(DATE, office, JAKARTA)).toEqual({
      startAt: '2026-09-14T01:00:00.000Z',
      endAt: '2026-09-14T10:00:00.000Z',
      windowFrom: '2026-09-14T00:00:00.000Z',
      windowTo: '2026-09-14T11:00:00.000Z',
    });
  });

  it('night 22:00–06:00 → 15:00Z → 23:00Z, window 14:00Z → 00:00Z next day', () => {
    expect(instantsFor(DATE, night, JAKARTA)).toEqual({
      startAt: '2026-09-14T15:00:00.000Z',
      endAt: '2026-09-14T23:00:00.000Z',
      windowFrom: '2026-09-14T14:00:00.000Z',
      windowTo: '2026-09-15T00:00:00.000Z',
    });
  });

  it('morning 06:00–14:00 → 23:00Z the previous day → 07:00Z', () => {
    expect(instantsFor(DATE, morning, JAKARTA)).toEqual({
      startAt: '2026-09-13T23:00:00.000Z',
      endAt: '2026-09-14T07:00:00.000Z',
      windowFrom: '2026-09-13T22:00:00.000Z',
      windowTo: '2026-09-14T08:00:00.000Z',
    });
  });

  it('BR-SHF-008: the same wall clock in Jayapura is two hours earlier in UTC', () => {
    const jakarta = instantsFor(DATE, office, JAKARTA);
    const jayapura = instantsFor(DATE, office, 'Asia/Jayapura');
    expect(Date.parse(jakarta.startAt) - Date.parse(jayapura.startAt)).toBe(2 * 3_600_000);
  });

  it('BR-SHF-008: Makassar sits one hour between them', () => {
    const makassar = instantsFor(DATE, office, 'Asia/Makassar');
    expect(makassar.startAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('leap day is an ordinary date', () => {
    expect(instantsFor('2028-02-29', office, JAKARTA).startAt).toBe('2028-02-29T01:00:00.000Z');
  });
});

describe('window minutes', () => {
  it('a night shift’s window spans three calendar dates in minute space', () => {
    // −60 is the previous evening; 1500 is past the following midnight.
    expect(windowMinutes(night)).toEqual({ from: 1320 - 60, to: 1320 + 480 + 60 });
  });
});
