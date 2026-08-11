import { ScheduleQueryService } from './schedule-query.service';
import {
  BRANCH,
  COMPANY,
  EMPLOYEE,
  FakeAssignments,
  FakeCache,
  FakePatterns,
  FakeRosterDays,
  FakeShifts,
  fakeHolidays,
  fakeOrg,
  inScope,
} from './test-support';
import type { HolidayQueryPort } from '../../holiday';
import type { OrgQueryPort } from '../../organization';

/**
 * UC-SHF-001 through the service rather than the reducer: the ladder's inputs are
 * loaded here, and the specs that matter are the ones about **which rows are
 * asked for** — the cache bucket, the company default, the holiday scope.
 */
describe('ScheduleQueryService', () => {
  let shifts: FakeShifts;
  let patterns: FakePatterns;
  let assignments: FakeAssignments;
  let rosterDays: FakeRosterDays;
  let cache: FakeCache;

  function build(options: { org?: OrgQueryPort; holidays?: HolidayQueryPort } = {}) {
    return new ScheduleQueryService(
      shifts,
      patterns,
      assignments,
      rosterDays,
      cache,
      options.org ?? fakeOrg(),
      options.holidays ?? fakeHolidays(),
    );
  }

  beforeEach(() => {
    shifts = new FakeShifts();
    patterns = new FakePatterns();
    assignments = new FakeAssignments();
    rosterDays = new FakeRosterDays();
    cache = new FakeCache();
  });

  /** A 5-2 week anchored on Monday 2026-09-14. */
  function weekdayPattern(overrides: Partial<{ observesHolidays: boolean }> = {}) {
    const office = shifts.seed({ code: 'OFFICE' });
    const pattern = patterns.seed({
      observesHolidays: overrides.observesHolidays ?? true,
      days: [
        { dayIndex: 0, shiftId: office.id },
        { dayIndex: 1, shiftId: office.id },
        { dayIndex: 2, shiftId: office.id },
        { dayIndex: 3, shiftId: office.id },
        { dayIndex: 4, shiftId: office.id },
        { dayIndex: 5, shiftId: null },
        { dayIndex: 6, shiftId: null },
      ],
    });
    return { office, pattern };
  }

  it('resolves a pattern day into a worked verdict with instants', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({
      patternId: pattern.id,
      effectiveFrom: '2026-09-01',
      cycleAnchorDate: '2026-09-14',
    });

    const day = await inScope([], () => build().scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day).toMatchObject({ kind: 'work', source: 'pattern', standardMinutes: 480 });
    expect(day.shift?.startAt).toBe('2026-09-15T01:00:00.000Z');
  });

  it('falls back to the company default when the employee has no arrangement', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({
      employeeId: null,
      patternId: pattern.id,
      effectiveFrom: '2026-09-01',
      cycleAnchorDate: '2026-09-14',
    });

    const day = await inScope([], () => build().scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day).toMatchObject({ kind: 'work', source: 'default' });
  });

  it('lets an explicit row beat both', async () => {
    const { pattern, office } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });
    const night = shifts.seed({ code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
    rosterDays.seed({ date: '2026-09-15', shiftId: night.id });

    const day = await inScope([], () => build().scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day.source).toBe('explicit');
    expect(day.shift?.id).toBe(night.id);
    expect(day.shift?.id).not.toBe(office.id);
  });

  it('BR-SHF-004: suppresses a holiday for an observing arrangement', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });
    const holidays = fakeHolidays([
      { date: '2026-09-15', kind: 'national', name: 'National day A' },
    ]);

    const day = await inScope([], () => build({ holidays }).scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day).toMatchObject({ kind: 'off', offReason: 'holiday', standardMinutes: 480 });
  });

  it('asks the holiday port for the employee’s own branch scope', async () => {
    const asked: { companyId: string; branchId: string | null }[] = [];
    const holidays: HolidayQueryPort = {
      dayType: () => Promise.resolve({ working: true }),
      nonWorkingDays: (companyId, branchId) => {
        asked.push({ companyId, branchId });
        return Promise.resolve([]);
      },
    };
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });

    await inScope([], () => build({ holidays }).scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(asked).toEqual([{ companyId: COMPANY, branchId: BRANCH }]);
  });

  it('BR-SHF-008: an unplaced employee resolves off/unplaced', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });
    const org = fakeOrg({ placement: () => Promise.resolve(null) });

    const day = await inScope([], () => build({ org }).scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day).toMatchObject({ kind: 'off', offReason: 'unplaced' });
  });

  it('builds a month bucket once and serves the rest of the month from it', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });
    const service = build();

    await inScope([], async () => {
      await service.scheduleFor(EMPLOYEE, '2026-09-15');
      await service.scheduleFor(EMPLOYEE, '2026-09-16');
    });

    expect(cache.entries.size).toBe(1);
    expect(cache.reads).toBe(2);
  });

  it('scheduleRange spans months and stays half-open', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });

    const days = await inScope([], () =>
      build().scheduleRange(EMPLOYEE, '2026-09-28', '2026-10-03'),
    );
    expect(days.map((day) => day.date)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('scheduleForMany keys by employee and answers the unassigned one too', async () => {
    const { pattern } = weekdayPattern();
    assignments.seed({ patternId: pattern.id, cycleAnchorDate: '2026-09-14' });

    const resolved = await inScope([], () =>
      build().scheduleForMany([EMPLOYEE, 'emp-other'], '2026-09-15'),
    );
    expect(resolved.get(EMPLOYEE)?.kind).toBe('work');
    expect(resolved.get('emp-other')).toMatchObject({ kind: 'off', offReason: 'unscheduled' });
  });

  it('BR-SHF-010: nothing is materialized — an unrostered employee has no rows at all', async () => {
    const day = await inScope([], () => build().scheduleFor(EMPLOYEE, '2026-09-15'));
    expect(day).toMatchObject({ kind: 'off', source: 'none', offReason: 'unscheduled' });
    expect(rosterDays.rows).toEqual([]);
  });
});
