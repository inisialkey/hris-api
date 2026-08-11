import { RosterDayService } from './roster-day.service';
import { ScheduleQueryService } from './schedule-query.service';
import { WriteGuards } from './write-guards';
import { BULK_LIMIT } from './roster-day.service';
import {
  COMPANY,
  EMPLOYEE,
  FakeAssignments,
  FakeCache,
  FakeEmployees,
  FakeOutbox,
  FakePatterns,
  FakeRosterDays,
  FakeShifts,
  clock,
  fakeHolidays,
  fakeOrg,
  fakePeriods,
  inScope,
} from './test-support';
import type { PeriodLockPort } from '../../../shared/period-lock.port';

const ASSIGN = ['shift.roster.assign'];

describe('RosterDayService — UC-SHF-005', () => {
  let shifts: FakeShifts;
  let patterns: FakePatterns;
  let assignments: FakeAssignments;
  let rosterDays: FakeRosterDays;
  let employees: FakeEmployees;
  let cache: FakeCache;
  let outbox: FakeOutbox;

  function build(periods: PeriodLockPort = fakePeriods()) {
    const org = fakeOrg();
    const schedule = new ScheduleQueryService(
      shifts,
      patterns,
      assignments,
      rosterDays,
      cache,
      org,
      fakeHolidays(),
    );
    const guards = new WriteGuards(periods, org, clock, schedule);
    return new RosterDayService(rosterDays, shifts, employees, cache, outbox, guards);
  }

  beforeEach(() => {
    shifts = new FakeShifts();
    patterns = new FakePatterns();
    assignments = new FakeAssignments();
    rosterDays = new FakeRosterDays();
    employees = new FakeEmployees();
    cache = new FakeCache();
    outbox = new FakeOutbox();
    employees.seed();
  });

  it('paints a cell and reports the row it wrote', async () => {
    const office = shifts.seed();
    const service = build();

    const painted = await inScope(ASSIGN, () =>
      service.paint([{ employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id }]),
    );

    expect(painted.ok).toBe(true);
    if (painted.ok) expect(painted.value[0]).toMatchObject({ success: true, date: '2026-09-15' });
    expect(rosterDays.rows).toHaveLength(1);
  });

  it('writes an explicit day off when the shift is null', async () => {
    const service = build();
    await inScope(ASSIGN, () =>
      service.paint([{ employeeId: EMPLOYEE, date: '2026-09-15', shiftId: null }]),
    );
    expect(rosterDays.rows[0]).toMatchObject({ shiftId: null });
  });

  it('§7: a partial batch is normal — one bad cell does not drop the rest', async () => {
    const office = shifts.seed();
    const service = build();

    const painted = await inScope(ASSIGN, () =>
      service.paint([
        { employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id },
        { employeeId: 'ghost', date: '2026-09-15', shiftId: office.id },
      ]),
    );

    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    expect(painted.value.map((result) => result.success)).toEqual([true, false]);
    expect(painted.value[1]?.error?.code).toBe('SYS_NOT_FOUND');
    expect(rosterDays.rows).toHaveLength(1);
  });

  it('rejects an in-batch duplicate before writing anything', async () => {
    const office = shifts.seed();
    const service = build();

    const painted = await inScope(ASSIGN, () =>
      service.paint([
        { employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id },
        { employeeId: EMPLOYEE, date: '2026-09-15', shiftId: null },
      ]),
    );

    expect(painted.ok).toBe(false);
    expect(rosterDays.rows).toEqual([]);
  });

  it('caps the batch at a hundred items', async () => {
    const office = shifts.seed();
    const service = build();
    const items = Array.from({ length: BULK_LIMIT + 1 }, (_, index) => ({
      employeeId: EMPLOYEE,
      date: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
      shiftId: office.id,
    }));

    expect((await inScope(ASSIGN, () => service.paint(items))).ok).toBe(false);
  });

  it('BR-SHF-009: a locked date refuses its own cell and nothing else', async () => {
    const office = shifts.seed();
    const service = build(fakePeriods({ date: '2026-09-15', periodId: 'per-1', label: 'Sep' }));

    const painted = await inScope(ASSIGN, () =>
      service.paint([
        { employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id },
        { employeeId: EMPLOYEE, date: '2026-09-16', shiftId: office.id },
      ]),
    );

    expect(painted.ok).toBe(true);
    if (!painted.ok) return;
    expect(painted.value[0]).toMatchObject({
      success: false,
      error: { code: 'SHF_PERIOD_LOCKED' },
    });
    expect(painted.value[1]?.success).toBe(true);
  });

  it('BR-SHF-006: a cell colliding with its neighbour’s window is refused', async () => {
    const night = shifts.seed({
      code: 'NIGHT',
      startTime: '22:00:00',
      endTime: '06:00:00',
      breakMinutes: 30,
    });
    const morning = shifts.seed({
      code: 'MORNING',
      startTime: '06:00:00',
      endTime: '14:00:00',
      breakMinutes: 45,
    });
    rosterDays.seed({ date: '2026-09-15', shiftId: night.id });
    const service = build();

    const painted = await inScope(ASSIGN, () =>
      service.paint([{ employeeId: EMPLOYEE, date: '2026-09-16', shiftId: morning.id }]),
    );

    expect(painted.ok).toBe(true);
    if (painted.ok) {
      expect(painted.value[0]).toMatchObject({
        success: false,
        error: { code: 'SHF_SHIFT_WINDOW_OVERLAP' },
      });
    }
  });

  it('§8: a date years away is a fat finger', async () => {
    const office = shifts.seed();
    const service = build();
    const painted = await inScope(ASSIGN, () =>
      service.paint([{ employeeId: EMPLOYEE, date: '2091-09-15', shiftId: office.id }]),
    );
    if (painted.ok) expect(painted.value[0]?.error?.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('§12: one event per batch, carrying every employee and date it touched', async () => {
    const office = shifts.seed();
    employees.seed({ employeeId: 'emp-2', employeeNumber: 'EMP-0002', userId: 'user-2' });
    const service = build();

    await inScope(ASSIGN, () =>
      service.paint([
        { employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id },
        { employeeId: 'emp-2', date: '2026-09-16', shiftId: office.id },
      ]),
    );

    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({
      name: 'shift.roster.changed',
      payload: { employeeIds: [EMPLOYEE, 'emp-2'], dates: ['2026-09-15', '2026-09-16'] },
    });
    expect(cache.busted).toEqual([EMPLOYEE, 'emp-2']);
  });

  it('emits nothing when every cell failed', async () => {
    const service = build();
    await inScope(ASSIGN, () =>
      service.paint([{ employeeId: 'ghost', date: '2026-09-15', shiftId: null }]),
    );
    expect(outbox.events).toEqual([]);
  });

  it('clearing a cell deletes the row so the date falls back to its pattern', async () => {
    const row = rosterDays.seed({ date: '2026-09-15' });
    const service = build();

    const cleared = await inScope(ASSIGN, () => service.clear(row.id));
    expect(cleared.ok).toBe(true);
    expect(rosterDays.rows).toEqual([]);
    expect(outbox.events).toHaveLength(1);
  });

  it('refuses to clear a cell inside a locked period', async () => {
    const row = rosterDays.seed({ date: '2026-09-15' });
    const service = build(fakePeriods({ date: '2026-09-15', periodId: 'per-1', label: 'Sep' }));

    const cleared = await inScope(ASSIGN, () => service.clear(row.id));
    expect(cleared.ok).toBe(false);
    expect(rosterDays.rows).toHaveLength(1);
  });

  it('answers 404 for a company outside the caller’s scope', async () => {
    const office = shifts.seed();
    const service = build();
    const painted = await inScope(
      ASSIGN,
      () => service.paint([{ employeeId: EMPLOYEE, date: '2026-09-15', shiftId: office.id }]),
      ['another-company'],
    );
    if (painted.ok) expect(painted.value[0]?.error?.code).toBe('SYS_NOT_FOUND');
    expect(COMPANY).not.toBe('another-company');
  });
});
