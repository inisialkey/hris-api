import { cycleConflicts, neighbourConflict, windowsOverlap } from './overlap';
import type { ShiftTimes } from './time';

const office: ShiftTimes = {
  startTime: '08:00:00',
  endTime: '17:00:00',
  breakMinutes: 60,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};
const night: ShiftTimes = {
  startTime: '22:00:00',
  endTime: '06:00:00',
  breakMinutes: 30,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};
const morning: ShiftTimes = {
  startTime: '06:00:00',
  endTime: '14:00:00',
  breakMinutes: 45,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};
const tightMorning: ShiftTimes = { ...morning, punchInBeforeMinutes: 0 };
/** 23 hours with an hour either side — the only way one date's window reaches the next. */
const marathon: ShiftTimes = {
  startTime: '06:00:00',
  endTime: '05:00:00',
  breakMinutes: 60,
  punchInBeforeMinutes: 60,
  punchOutAfterMinutes: 60,
};

describe('BR-SHF-006 — window overlap', () => {
  it('§9: a night shift into a morning shift overlaps by two hours', () => {
    // Night's out-window closes 07:00 next day; morning's in-window opens 05:00.
    expect(windowsOverlap(night, morning)).toBe(true);
  });

  it('shrinking both windows to nothing is what resolves it — that is what they are for', () => {
    // 06:00 end meets 06:00 start exactly: with either window open by a minute
    // the two still touch, which is why the tenant has to close both.
    expect(windowsOverlap({ ...night, punchOutAfterMinutes: 0 }, tightMorning)).toBe(false);
    expect(windowsOverlap({ ...night, punchOutAfterMinutes: 1 }, tightMorning)).toBe(true);
  });

  it('two office days do not overlap', () => {
    expect(windowsOverlap(office, office)).toBe(false);
  });

  it('a night shift against itself on consecutive days does not overlap', () => {
    // Out-window closes 07:00; the next night's in-window opens 21:00 that evening.
    expect(windowsOverlap(night, night)).toBe(false);
  });

  it('a 23-hour shift does overlap itself — span plus both windows exceeds a day', () => {
    expect(windowsOverlap(marathon, marathon)).toBe(true);
  });
});

describe('UC-SHF-003 — the cycle, wrap included', () => {
  const shifts = new Map<string, ShiftTimes>([
    ['office', office],
    ['night', night],
    ['morning', morning],
  ]);

  it('flags consecutive entries that collide', () => {
    const conflicts = cycleConflicts(
      [
        { dayIndex: 0, shiftId: 'night' },
        { dayIndex: 1, shiftId: 'morning' },
      ],
      2,
      shifts,
    );
    expect(conflicts).toContainEqual({
      dayIndex: 0,
      shiftId: 'night',
      conflictingShiftId: 'morning',
    });
  });

  it('checks the wrap from the last index back to the first', () => {
    const conflicts = cycleConflicts(
      [
        { dayIndex: 0, shiftId: 'morning' },
        { dayIndex: 1, shiftId: 'office' },
        { dayIndex: 2, shiftId: 'night' },
      ],
      3,
      shifts,
    );
    // 0→1 and 1→2 are clean; 2→0 is the night-into-morning wrap.
    expect(conflicts).toEqual([{ dayIndex: 2, shiftId: 'night', conflictingShiftId: 'morning' }]);
  });

  it('checks a one-day cycle against itself', () => {
    const daily = new Map<string, ShiftTimes>([...shifts, ['marathon', marathon]]);
    expect(cycleConflicts([{ dayIndex: 0, shiftId: 'marathon' }], 1, daily)).toHaveLength(1);
    expect(cycleConflicts([{ dayIndex: 0, shiftId: 'night' }], 1, daily)).toEqual([]);
  });

  it('an OFF entry breaks the chain rather than conflicting', () => {
    expect(
      cycleConflicts(
        [
          { dayIndex: 0, shiftId: 'night' },
          { dayIndex: 1, shiftId: null },
          { dayIndex: 2, shiftId: 'morning' },
        ],
        3,
        shifts,
      ),
    ).toEqual([]);
  });
});

describe('UC-SHF-005 — the neighbour check', () => {
  const incoming = { shiftId: 'morning', times: morning };

  it('flags the day before', () => {
    expect(
      neighbourConflict('2026-09-15', incoming, { shiftId: 'night', times: night }, null),
    ).toEqual({ date: '2026-09-15', shiftId: 'morning', conflictingShiftId: 'night' });
  });

  it('flags the day after', () => {
    expect(
      neighbourConflict('2026-09-15', { shiftId: 'night', times: night }, null, {
        shiftId: 'morning',
        times: morning,
      }),
    ).toEqual({ date: '2026-09-15', shiftId: 'night', conflictingShiftId: 'morning' });
  });

  it('passes when both neighbours are clean', () => {
    expect(
      neighbourConflict(
        '2026-09-15',
        incoming,
        { shiftId: 'office', times: office },
        { shiftId: 'office', times: office },
      ),
    ).toBeNull();
  });

  it('clearing a cell can never conflict', () => {
    expect(
      neighbourConflict('2026-09-15', null, { shiftId: 'night', times: night }, null),
    ).toBeNull();
  });
});
