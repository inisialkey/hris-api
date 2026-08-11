import type { ParsedRow } from '../../import-export';
import { ScheduleQueryService } from './schedule-query.service';
import { ShiftImportHandler, shiftImportDefinition } from './shift-import';
import { WriteGuards } from './write-guards';
import {
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

function row(values: Record<string, unknown>): ParsedRow {
  return { rowNumber: 2, values: values as ParsedRow['values'] };
}

describe('shift.roster import — UC-SHF-006', () => {
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
    return new ShiftImportHandler(
      rosterDays,
      shifts,
      employees,
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

  describe('the definition — BR-SHF-012', () => {
    const definition = shiftImportDefinition({
      apply: () => Promise.resolve({ ok: true, value: undefined }),
    });

    it('upserts on (employee_number, date), partial commit', () => {
      expect(definition).toMatchObject({
        key: 'shift.roster',
        requiredPermission: 'shift.roster.import',
        naturalKey: ['employee_number', 'date'],
        writeMode: 'upsert',
        commitMode: 'partial',
      });
    });

    it('carries the four columns and nothing that would create a shift', () => {
      expect(definition.columns.map((column) => column.key)).toEqual([
        'employee_number',
        'date',
        'shift_code',
        'works_on_holiday',
      ]);
    });
  });

  it('writes a roster day and announces it', async () => {
    const office = shifts.seed({ code: 'OFFICE' });
    const handler = build();

    const applied = await inScope([], () =>
      handler.apply(row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'OFFICE' })),
    );

    expect(applied.ok).toBe(true);
    expect(rosterDays.rows[0]).toMatchObject({ employeeId: EMPLOYEE, shiftId: office.id });
    expect(outbox.events[0]).toMatchObject({ name: 'shift.roster.changed' });
  });

  it('BR-SHF-012: the `OFF` sentinel writes an explicit day off', async () => {
    shifts.seed({ code: 'OFFICE' });
    const handler = build();

    await inScope([], () =>
      handler.apply(row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'OFF' })),
    );
    expect(rosterDays.rows[0]).toMatchObject({ shiftId: null });
  });

  it('carries `works_on_holiday` through, which is the flag BR-SHF-004 reads', async () => {
    shifts.seed({ code: 'OFFICE' });
    const handler = build();

    await inScope([], () =>
      handler.apply(
        row({
          employee_number: 'EMP-0001',
          date: '2026-09-15',
          shift_code: 'OFFICE',
          works_on_holiday: true,
        }),
      ),
    );
    expect(rosterDays.rows[0]?.worksOnHoliday).toBe(true);
  });

  it('upserts rather than duplicating the cell', async () => {
    const office = shifts.seed({ code: 'OFFICE' });
    rosterDays.seed({ date: '2026-09-15', shiftId: null });
    const handler = build();

    await inScope([], () =>
      handler.apply(row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'OFFICE' })),
    );
    expect(rosterDays.rows).toHaveLength(1);
    expect(rosterDays.rows[0]?.shiftId).toBe(office.id);
  });

  describe('check — the same validation as a UI write', () => {
    it('rejects an unknown employee number', async () => {
      const errors = await inScope([], () =>
        build().check(row({ employee_number: 'NOPE', date: '2026-09-15', shift_code: 'OFFICE' })),
      );
      expect(errors[0]).toMatchObject({ column: 'employee_number', code: 'VAL_INVALID_ENUM' });
    });

    it('rejects a terminal employee', async () => {
      employees.seed({ employeeId: 'emp-gone', employeeNumber: 'EMP-9', status: 'resigned' });
      const errors = await inScope([], () =>
        build().check(row({ employee_number: 'EMP-9', date: '2026-09-15', shift_code: 'OFFICE' })),
      );
      expect(errors[0]).toMatchObject({ column: 'employee_number' });
    });

    it('rejects an unknown shift code', async () => {
      const errors = await inScope([], () =>
        build().check(row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'NOPE' })),
      );
      expect(errors[0]).toMatchObject({ column: 'shift_code', code: 'VAL_INVALID_ENUM' });
    });

    it('rejects a locked date', async () => {
      shifts.seed({ code: 'OFFICE' });
      const handler = build(fakePeriods({ date: '2026-09-15', periodId: 'per-1', label: 'Sep' }));

      const errors = await inScope([], () =>
        handler.check(
          row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'OFFICE' }),
        ),
      );
      expect(errors[0]).toMatchObject({ column: 'date', code: 'SHF_PERIOD_LOCKED' });
    });

    it('rejects a neighbour-window collision', async () => {
      const night = shifts.seed({ code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00' });
      shifts.seed({ code: 'MORNING', startTime: '06:00:00', endTime: '14:00:00' });
      rosterDays.seed({ date: '2026-09-15', shiftId: night.id });

      const errors = await inScope([], () =>
        build().check(
          row({ employee_number: 'EMP-0001', date: '2026-09-16', shift_code: 'MORNING' }),
        ),
      );
      expect(errors[0]).toMatchObject({
        column: 'shift_code',
        code: 'SHF_SHIFT_WINDOW_OVERLAP',
      });
    });

    it('passes a clean row', async () => {
      shifts.seed({ code: 'OFFICE' });
      const errors = await inScope([], () =>
        build().check(
          row({ employee_number: 'EMP-0001', date: '2026-09-15', shift_code: 'OFFICE' }),
        ),
      );
      expect(errors).toEqual([]);
    });
  });
});
