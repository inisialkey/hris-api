import { RosterAssignmentService } from './roster-assignment.service';
import { ScheduleQueryService } from './schedule-query.service';
import { WriteGuards } from './write-guards';
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

const ASSIGN = ['shift.roster.assign', 'shift.roster.read'];

describe('RosterAssignmentService — UC-SHF-004', () => {
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
    return new RosterAssignmentService(
      assignments,
      patterns,
      employees,
      shifts,
      cache,
      outbox,
      new WriteGuards(periods, org, clock, schedule),
    );
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

  function seedPattern() {
    const office = shifts.seed();
    return patterns.seed({ days: [{ dayIndex: 0, shiftId: office.id }], cycleLength: 1 });
  }

  it('assigns a pattern and announces the roster change', async () => {
    const pattern = seedPattern();
    const assigned = await inScope(ASSIGN, () =>
      build().assign({
        employeeId: EMPLOYEE,
        companyId: COMPANY,
        patternId: pattern.id,
        effectiveFrom: '2026-10-01',
      }),
    );

    expect(assigned.ok).toBe(true);
    if (assigned.ok) expect(assigned.value.cycleAnchorDate).toBe('2026-10-01');
    expect(outbox.events[0]).toMatchObject({ name: 'shift.roster.changed' });
    expect(cache.busted).toEqual([EMPLOYEE]);
  });

  it('supersedes the live arrangement rather than overwriting it', async () => {
    const pattern = seedPattern();
    const current = assignments.seed({ patternId: pattern.id, effectiveFrom: '2026-09-01' });

    await inScope(ASSIGN, () =>
      build().assign({
        employeeId: EMPLOYEE,
        companyId: COMPANY,
        patternId: pattern.id,
        effectiveFrom: '2026-10-01',
      }),
    );

    expect(assignments.rows).toHaveLength(2);
    expect(assignments.rows.find((row) => row.id === current.id)?.effectiveTo).toBe('2026-10-01');
  });

  it('writes the company-default row when no employee is named', async () => {
    const pattern = seedPattern();
    const assigned = await inScope(ASSIGN, () =>
      build().assign({
        employeeId: null,
        companyId: COMPANY,
        patternId: pattern.id,
        effectiveFrom: '2026-10-01',
      }),
    );

    expect(assigned.ok).toBe(true);
    if (assigned.ok) expect(assigned.value.employeeId).toBeNull();
    // A default arrangement addresses every employee, so the bust is tenant-wide.
    expect(cache.busted).toEqual(['*']);
  });

  it('refuses a pattern from another company as 404', async () => {
    const foreign = patterns.seed({ companyId: 'other-company' });
    const assigned = await inScope(ASSIGN, () =>
      build().assign({
        employeeId: EMPLOYEE,
        companyId: COMPANY,
        patternId: foreign.id,
        effectiveFrom: '2026-10-01',
      }),
    );
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.code).toBe('SYS_NOT_FOUND');
  });

  it('BR-SHF-009: an effective date inside a locked period is refused', async () => {
    const pattern = seedPattern();
    const service = build(fakePeriods({ date: '2026-10-01', periodId: 'per-1', label: 'Oct' }));

    const assigned = await inScope(ASSIGN, () =>
      service.assign({
        employeeId: EMPLOYEE,
        companyId: COMPANY,
        patternId: pattern.id,
        effectiveFrom: '2026-10-01',
      }),
    );
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.code).toBe('SHF_PERIOD_LOCKED');
  });

  it('BR-SHF-006: refuses a switch-over whose incoming shift collides with the outgoing one', async () => {
    const night = shifts.seed({ code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
    const morning = shifts.seed({ code: 'MORNING', startTime: '06:00:00', endTime: '14:00:00' });
    rosterDays.seed({ date: '2026-09-30', shiftId: night.id });
    const incoming = patterns.seed({
      code: 'MORNINGS',
      cycleLength: 1,
      days: [{ dayIndex: 0, shiftId: morning.id }],
    });

    const assigned = await inScope(ASSIGN, () =>
      build().assign({
        employeeId: EMPLOYEE,
        companyId: COMPANY,
        patternId: incoming.id,
        effectiveFrom: '2026-10-01',
      }),
    );
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.code).toBe('SHF_SHIFT_WINDOW_OVERLAP');
  });

  describe('bulk-assign — api-standards §10', () => {
    it('returns per-item results rather than failing the batch', async () => {
      const pattern = seedPattern();
      employees.seed({ employeeId: 'emp-2', employeeNumber: 'EMP-0002', userId: 'user-2' });

      const assigned = await inScope(ASSIGN, () =>
        build().bulkAssign({
          employeeIds: [EMPLOYEE, 'emp-2', 'ghost'],
          companyId: COMPANY,
          patternId: pattern.id,
          effectiveFrom: '2026-10-01',
        }),
      );

      expect(assigned.ok).toBe(true);
      if (!assigned.ok) return;
      expect(assigned.value.map((result) => result.success)).toEqual([true, true, false]);
      expect(assigned.value[2]?.error?.code).toBe('SYS_NOT_FOUND');
    });

    it('rejects a duplicate id before writing anything', async () => {
      const pattern = seedPattern();
      const assigned = await inScope(ASSIGN, () =>
        build().bulkAssign({
          employeeIds: [EMPLOYEE, EMPLOYEE],
          companyId: COMPANY,
          patternId: pattern.id,
          effectiveFrom: '2026-10-01',
        }),
      );
      expect(assigned.ok).toBe(false);
      expect(assignments.rows).toEqual([]);
    });
  });

  describe('cancel', () => {
    it('cancels a scheduled row and reopens its predecessor', async () => {
      const pattern = seedPattern();
      const current = assignments.seed({
        patternId: pattern.id,
        effectiveFrom: '2026-09-01',
        effectiveTo: '2026-10-01',
      });
      const scheduled = assignments.seed({ patternId: pattern.id, effectiveFrom: '2026-10-01' });

      const cancelled = await inScope(ASSIGN, () => build().cancel(scheduled.id));
      expect(cancelled.ok).toBe(true);
      expect(assignments.rows.find((row) => row.id === current.id)?.effectiveTo).toBeNull();
    });

    it('refuses a row that has already started', async () => {
      const pattern = seedPattern();
      const current = assignments.seed({ patternId: pattern.id, effectiveFrom: '2026-09-01' });

      const cancelled = await inScope(ASSIGN, () => build().cancel(current.id));
      expect(cancelled.ok).toBe(false);
      expect(assignments.rows).toHaveLength(1);
    });
  });

  it('§7: the history read needs an employee or the company-default flag', async () => {
    const history = await inScope(ASSIGN, () => build().history({ companyId: COMPANY }));
    expect(history.ok).toBe(false);
    if (!history.ok) expect(history.error.code).toBe('VAL_VALIDATION_FAILED');
  });
});
