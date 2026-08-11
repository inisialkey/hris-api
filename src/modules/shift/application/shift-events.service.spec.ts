import type { NotificationPort, SendCommand } from '../../notification';
import { ScheduleQueryService } from './schedule-query.service';
import { ShiftEventHandlers } from './shift-events.service';
import { WriteGuards } from './write-guards';
import {
  EMPLOYEE,
  FakeAssignments,
  FakeCache,
  FakeEmployees,
  FakePatterns,
  FakeRosterDays,
  FakeShifts,
  TENANT,
  clock,
  fakeHolidays,
  fakeOrg,
  fakePeriods,
  inScope,
} from './test-support';

describe('ShiftEventHandlers — §12', () => {
  let rosterDays: FakeRosterDays;
  let employees: FakeEmployees;
  let cache: FakeCache;
  let sent: SendCommand[];

  function build() {
    const org = fakeOrg();
    const schedule = new ScheduleQueryService(
      new FakeShifts(),
      new FakePatterns(),
      new FakeAssignments(),
      rosterDays,
      cache,
      org,
      fakeHolidays(),
    );
    const notifications: NotificationPort = {
      send: (command: SendCommand) => {
        sent.push(command);
        return Promise.resolve({ created: 1, deduped: 0, suppressed: 0 });
      },
    } as NotificationPort;

    return new ShiftEventHandlers(
      cache,
      employees,
      rosterDays,
      notifications,
      new WriteGuards(fakePeriods(), org, clock, schedule),
    );
  }

  beforeEach(() => {
    rosterDays = new FakeRosterDays();
    employees = new FakeEmployees();
    cache = new FakeCache();
    sent = [];
    employees.seed();
  });

  describe('on.holiday.calendar.changed — UC-SHF-009', () => {
    it('busts the tenant and flags the deliberate holiday work, mutating nothing', async () => {
      rosterDays.seed({ date: '2026-12-25', worksOnHoliday: true, shiftId: 'shift-1' });
      rosterDays.seed({ date: '2026-12-25', employeeId: 'emp-2', worksOnHoliday: false });

      const result = await build().onHolidayCalendarChanged({
        tenantId: TENANT,
        dates: ['2026-12-25'],
      });

      expect(result.flagged).toEqual([{ employeeId: EMPLOYEE, date: '2026-12-25' }]);
      expect(cache.busted).toEqual(['*']);
      expect(rosterDays.rows).toHaveLength(2);
    });
  });

  it('on.organization.assignment.changed busts that employee’s buckets', async () => {
    await build().onPlacementChanged({ tenantId: TENANT, employeeId: EMPLOYEE });
    expect(cache.busted).toEqual([EMPLOYEE]);
  });

  it('on.employee.status.changed busts and stops nothing — UC-SHF-010', async () => {
    rosterDays.seed({ date: '2026-09-15' });
    await build().onEmployeeStatusChanged({ tenantId: TENANT, employeeId: EMPLOYEE });

    expect(cache.busted).toEqual([EMPLOYEE]);
    // The roster is history and keeps resolving; consumers stop asking.
    expect(rosterDays.rows).toHaveLength(1);
  });

  describe('on.shift.roster.changed — §13’s batching', () => {
    it('sends one message per employee for a future change', async () => {
      const result = await build().onRosterChanged({
        employeeIds: [EMPLOYEE],
        dates: ['2026-09-15', '2026-09-16'],
      });

      expect(result.notified).toEqual([EMPLOYEE]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        templateKey: 'shift.roster_changed',
        recipients: { kind: 'users', userIds: ['user-1'] },
        params: { firstDate: '2026-09-15', dateCount: 2 },
      });
    });

    it('sends nothing for a past-date-only edit — bookkeeping is not news', async () => {
      const result = await build().onRosterChanged({
        employeeIds: [EMPLOYEE],
        dates: ['2026-09-01'],
      });
      expect(result.notified).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('skips an employee with no login', async () => {
      employees.seed({ employeeId: 'emp-3', employeeNumber: 'EMP-0003', userId: null });
      const result = await build().onRosterChanged({
        employeeIds: ['emp-3'],
        dates: ['2026-09-15'],
      });
      expect(result.notified).toEqual([]);
    });

    it('dedupes on the batch’s own span rather than on the moment', async () => {
      await build().onRosterChanged({ employeeIds: [EMPLOYEE], dates: ['2026-09-15'] });
      await build().onRosterChanged({ employeeIds: [EMPLOYEE], dates: ['2026-09-15'] });
      expect(sent[0]?.dedupeKey).toBe(sent[1]?.dedupeKey);
    });
  });

  it('is callable inside a request scope, which is where the relay will call it', async () => {
    await inScope([], () => build().onPlacementChanged({ tenantId: TENANT, employeeId: EMPLOYEE }));
    expect(cache.busted).toEqual([EMPLOYEE]);
  });
});
