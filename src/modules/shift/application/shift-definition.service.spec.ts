import { PatternService } from './pattern.service';
import { ScheduleQueryService } from './schedule-query.service';
import { ShiftDefinitionService } from './shift-definition.service';
import { WriteGuards } from './write-guards';
import {
  COMPANY,
  EMPLOYEE,
  FakeAssignments,
  FakeCache,
  FakeOutbox,
  FakePatterns,
  FakeRosterDays,
  FakeShifts,
  clock,
  fakeHolidays,
  fakeOrg,
  fakePeriods,
  inScope,
  shift,
} from './test-support';
import type { PeriodLockPort } from '../../../shared/period-lock.port';

const CONFIGURE = ['shift.definition.configure', 'shift.definition.read'];

describe('ShiftDefinitionService — UC-SHF-002', () => {
  let shifts: FakeShifts;
  let patterns: FakePatterns;
  let assignments: FakeAssignments;
  let rosterDays: FakeRosterDays;
  let cache: FakeCache;
  let outbox: FakeOutbox;

  function guards(periods: PeriodLockPort = fakePeriods()) {
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
    return new WriteGuards(periods, org, clock, schedule);
  }

  function build(periods: PeriodLockPort = fakePeriods()) {
    return new ShiftDefinitionService(shifts, patterns, rosterDays, cache, outbox, guards(periods));
  }

  beforeEach(() => {
    shifts = new FakeShifts();
    patterns = new FakePatterns();
    assignments = new FakeAssignments();
    rosterDays = new FakeRosterDays();
    cache = new FakeCache();
    outbox = new FakeOutbox();
  });

  const input = { ...shift(), id: undefined } as unknown as Omit<ReturnType<typeof shift>, 'id'>;

  it('creates a shift and announces the definition change', async () => {
    const created = await inScope(CONFIGURE, () => build().create(input));
    expect(created.ok).toBe(true);
    expect(outbox.events[0]).toMatchObject({ name: 'shift.definition.changed' });
    // §12's coarse bust: the affected employee set is unbounded.
    expect(cache.busted).toEqual(['*']);
  });

  it('refuses the reserved `OFF` code', async () => {
    const created = await inScope(CONFIGURE, () => build().create({ ...input, code: 'OFF' }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('BR-SHF-001: equal start and end is not a window', async () => {
    const created = await inScope(CONFIGURE, () =>
      build().create({ ...input, startTime: '08:00:00', endTime: '08:00:00' }),
    );
    expect(created.ok).toBe(false);
  });

  it('accepts a cross-midnight shift — that is not a typo, it is a night', async () => {
    const created = await inScope(CONFIGURE, () =>
      build().create({ ...input, code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' }),
    );
    expect(created.ok).toBe(true);
  });

  it('§8: a break may not consume the whole span', async () => {
    const created = await inScope(CONFIGURE, () => build().create({ ...input, breakMinutes: 540 }));
    expect(created.ok).toBe(false);
  });

  it('§8: a break window outside the shift is out of range', async () => {
    const created = await inScope(CONFIGURE, () =>
      build().create({ ...input, breakStartTime: '19:00:00' }),
    );
    expect(created.ok).toBe(false);
  });

  it('§8: a break window inside a cross-midnight shift is accepted', async () => {
    const created = await inScope(CONFIGURE, () =>
      build().create({
        ...input,
        code: 'NIGHT',
        startTime: '22:00:00',
        endTime: '06:00:00',
        breakStartTime: '02:00:00',
      }),
    );
    expect(created.ok).toBe(true);
  });

  it('refuses a duplicate code in the same company', async () => {
    shifts.seed({ code: 'OFFICE' });
    const created = await inScope(CONFIGURE, () => build().create(input));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  describe('update', () => {
    it('re-checks every pattern using the shift when the times move', async () => {
      const night = shifts.seed({ code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
      const morning = shifts.seed({ code: 'MORNING', startTime: '09:00:00', endTime: '17:00:00' });
      patterns.seed({
        cycleLength: 2,
        days: [
          { dayIndex: 0, shiftId: night.id },
          { dayIndex: 1, shiftId: morning.id },
        ],
      });

      // Pulling the morning back to 06:00 makes it collide with the night before.
      const updated = await inScope(CONFIGURE, () =>
        build().update(morning.id, { startTime: '06:00:00' }),
      );
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error.code).toBe('SHF_SHIFT_WINDOW_OVERLAP');
    });

    it('leaves a name-only edit alone — no re-check, no lock question', async () => {
      const office = shifts.seed();
      rosterDays.seed({ date: '2026-09-15', shiftId: office.id });
      const service = build(fakePeriods({ date: '2026-09-15', periodId: 'per-1', label: 'Sep' }));

      const updated = await inScope(CONFIGURE, () => service.update(office.id, { name: 'Kantor' }));
      expect(updated.ok).toBe(true);
    });

    it('BR-SHF-009: a time change is refused when the shift is scheduled inside a locked period', async () => {
      const office = shifts.seed();
      rosterDays.seed({ date: '2026-09-15', shiftId: office.id, employeeId: EMPLOYEE });
      const service = build(fakePeriods({ date: '2026-09-15', periodId: 'per-1', label: 'Sep' }));

      const updated = await inScope(CONFIGURE, () =>
        service.update(office.id, { startTime: '09:00:00' }),
      );
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error.code).toBe('SHF_PERIOD_LOCKED');
    });
  });

  describe('archive — BR-SHF-011', () => {
    it('reports blocker counts rather than cascading', async () => {
      const office = shifts.seed();
      shifts.blockers = [{ type: 'roster_days', count: 3 }];

      const archived = await inScope(CONFIGURE, () => build().archive(office.id));
      expect(archived.ok).toBe(false);
      if (!archived.ok) {
        expect(archived.error.code).toBe('SHF_IN_USE');
        expect(archived.error.details).toMatchObject({
          blockers: [{ type: 'roster_days', count: 3 }],
        });
      }
    });

    it('archives a clean shift', async () => {
      const office = shifts.seed();
      const archived = await inScope(CONFIGURE, () => build().archive(office.id));
      expect(archived.ok).toBe(true);
      expect(shifts.archived).toEqual([office.id]);
    });
  });

  it('answers 404 for a company the caller cannot see', async () => {
    const created = await inScope(CONFIGURE, () => build().create(input), ['other-company']);
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('SYS_NOT_FOUND');
    expect(COMPANY).not.toBe('other-company');
  });
});

describe('PatternService — UC-SHF-003', () => {
  let shifts: FakeShifts;
  let patterns: FakePatterns;
  let assignments: FakeAssignments;
  let rosterDays: FakeRosterDays;
  let cache: FakeCache;
  let outbox: FakeOutbox;

  function build() {
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
    return new PatternService(
      patterns,
      shifts,
      cache,
      outbox,
      new WriteGuards(fakePeriods(), org, clock, schedule),
    );
  }

  beforeEach(() => {
    shifts = new FakeShifts();
    patterns = new FakePatterns();
    assignments = new FakeAssignments();
    rosterDays = new FakeRosterDays();
    cache = new FakeCache();
    outbox = new FakeOutbox();
  });

  function pattern(
    days: { dayIndex: number; shiftId: string | null }[],
    cycleLength = days.length,
  ) {
    return {
      companyId: COMPANY,
      code: '5-2',
      name: 'Five two',
      cycleLength,
      observesHolidays: true,
      days,
    };
  }

  it('saves the cycle as a replace-all', async () => {
    const office = shifts.seed();
    const created = await inScope(['shift.definition.configure'], () =>
      build().create(
        pattern([
          { dayIndex: 0, shiftId: office.id },
          { dayIndex: 1, shiftId: null },
        ]),
      ),
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.days).toHaveLength(2);
  });

  it('§8: refuses a strip that does not fill its cycle', async () => {
    const office = shifts.seed();
    const created = await inScope(['shift.definition.configure'], () =>
      build().create(pattern([{ dayIndex: 0, shiftId: office.id }], 7)),
    );
    expect(created.ok).toBe(false);
  });

  it('§8: refuses a duplicated index', async () => {
    const office = shifts.seed();
    const created = await inScope(['shift.definition.configure'], () =>
      build().create(
        pattern([
          { dayIndex: 0, shiftId: office.id },
          { dayIndex: 0, shiftId: null },
        ]),
      ),
    );
    expect(created.ok).toBe(false);
  });

  it('BR-SHF-006: refuses a cycle whose wrap collides', async () => {
    const night = shifts.seed({ code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
    const morning = shifts.seed({ code: 'MORNING', startTime: '06:00:00', endTime: '14:00:00' });

    const created = await inScope(['shift.definition.configure'], () =>
      build().create(
        pattern([
          { dayIndex: 0, shiftId: morning.id },
          { dayIndex: 1, shiftId: night.id },
        ]),
      ),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('SHF_SHIFT_WINDOW_OVERLAP');
  });

  it('refuses a shift belonging to another company as 404', async () => {
    const foreign = shifts.seed({ companyId: 'other-company' });
    const created = await inScope(['shift.definition.configure'], () =>
      build().create(pattern([{ dayIndex: 0, shiftId: foreign.id }])),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe('SYS_NOT_FOUND');
  });

  it('§7: changing the cycle length without a full strip is refused', async () => {
    const office = shifts.seed();
    const existing = patterns.seed({ cycleLength: 1, days: [{ dayIndex: 0, shiftId: office.id }] });

    const updated = await inScope(['shift.definition.configure'], () =>
      build().update(existing.id, { cycleLength: 7 }),
    );
    expect(updated.ok).toBe(false);
  });

  it('BR-SHF-011: an assigned pattern cannot be archived', async () => {
    const existing = patterns.seed();
    patterns.blockers = [{ type: 'roster_assignments', count: 2 }];

    const archived = await inScope(['shift.definition.configure'], () =>
      build().archive(existing.id),
    );
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.error.code).toBe('SHF_IN_USE');
  });
});
