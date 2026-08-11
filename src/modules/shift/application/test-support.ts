/**
 * Fakes shared by this module's use-case specs — hand-written in-memory doubles
 * (coding-standards-nestjs §9).
 *
 * The repositories store rows and apply the same live/soft-deleted and as-of
 * rules the real ones do, because most of what these specs assert is a read the
 * service makes *before* a write: the ladder's inputs, the neighbour days, the
 * blockers behind an archive.
 */

import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { LockedDate, PeriodLockPort } from '../../../shared/period-lock.port';
import type { HolidayQueryPort, NonWorkingDay } from '../../holiday';
import type { OrgQueryPort } from '../../organization';
import type {
  AssignmentRepositoryPort,
  EmployeeLookupPort,
  EmployeeSummary,
  PatternRepositoryPort,
  RosterDayRepositoryPort,
  ScheduleCachePort,
  ShiftOutboxPort,
  ShiftRepositoryPort,
} from '../domain/shift.ports';
import type {
  ArchiveBlocker,
  AssignmentRow,
  Page,
  Paged,
  PatternRow,
  PatternWithDays,
  RosterDayRow,
  ScheduledDay,
  ShiftRow,
} from '../domain/shift.types';

export const TENANT = '018f2f4a-0000-7000-8000-0000000c0001';
export const COMPANY = '018f2f4a-0000-7000-8000-0000000c0002';
export const BRANCH = '018f2f4a-0000-7000-8000-0000000c0003';
export const EMPLOYEE = '018f2f4a-0000-7000-8000-0000000c0004';
export const NOW = new Date('2026-09-10T03:00:00Z');
export const TODAY = '2026-09-10';
export const clock = { now: () => NOW };

export function inScope<T>(
  permissions: readonly string[],
  fn: () => Promise<T>,
  companyScope: 'all' | readonly string[] = 'all',
): Promise<T> {
  return runInContextScope({}, () => {
    setTenantContext({ tenantId: TENANT, source: 'jwt' });
    setRequestContext({
      requestId: 'request-1',
      userId: 'user-1',
      authorization: {
        resolve: () => Promise.resolve({ permissions: new Set(permissions), companyScope }),
      },
    });
    return fn();
  });
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

export function shift(overrides: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: 'shift-office',
    companyId: COMPANY,
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

export class FakeShifts implements ShiftRepositoryPort {
  rows: ShiftRow[] = [];
  archived: string[] = [];
  blockers: ArchiveBlocker[] = [];

  seed(overrides: Partial<ShiftRow> = {}): ShiftRow {
    const row = shift({ id: nextId('shift'), ...overrides });
    this.rows.push(row);
    return row;
  }

  list(filter: { companyId: string }, page: Page): Promise<Paged<ShiftRow>> {
    const rows = this.rows.filter((row) => row.companyId === filter.companyId);
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }

  findById(id: string): Promise<ShiftRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findByCode(companyId: string, code: string): Promise<ShiftRow | null> {
    return Promise.resolve(
      this.rows.find((row) => row.companyId === companyId && row.code === code) ?? null,
    );
  }

  findManyByIds(ids: string[]): Promise<Map<string, ShiftRow>> {
    return Promise.resolve(
      new Map(this.rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row])),
    );
  }

  findAllByCompany(companyId: string): Promise<Map<string, ShiftRow>> {
    return Promise.resolve(
      new Map(this.rows.filter((row) => row.companyId === companyId).map((row) => [row.id, row])),
    );
  }

  create(values: Omit<ShiftRow, 'id'>): Promise<ShiftRow> {
    return Promise.resolve(this.seed(values));
  }

  update(id: string, patch: Partial<ShiftRow>): Promise<ShiftRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return Promise.resolve(null);
    Object.assign(row, patch);
    return Promise.resolve(row);
  }

  archive(id: string): Promise<boolean> {
    this.archived.push(id);
    this.rows = this.rows.filter((row) => row.id !== id);
    return Promise.resolve(true);
  }

  archiveBlockers(): Promise<ArchiveBlocker[]> {
    return Promise.resolve(this.blockers);
  }

  usageCounts(ids: string[]): Promise<Map<string, number>> {
    return Promise.resolve(new Map(ids.map((id) => [id, 0])));
  }
}

export class FakePatterns implements PatternRepositoryPort {
  rows: PatternWithDays[] = [];
  blockers: ArchiveBlocker[] = [];
  archived: string[] = [];

  seed(overrides: Partial<PatternWithDays> = {}): PatternWithDays {
    const row: PatternWithDays = {
      id: nextId('pattern'),
      companyId: COMPANY,
      code: '5-2',
      name: 'Five two',
      cycleLength: 7,
      observesHolidays: true,
      days: [],
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  list(filter: { companyId: string }, page: Page): Promise<Paged<PatternWithDays>> {
    const rows = this.rows.filter((row) => row.companyId === filter.companyId);
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }

  findById(id: string): Promise<PatternWithDays | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findByCode(companyId: string, code: string): Promise<PatternRow | null> {
    return Promise.resolve(
      this.rows.find((row) => row.companyId === companyId && row.code === code) ?? null,
    );
  }

  findManyByIds(ids: string[]): Promise<Map<string, PatternWithDays>> {
    return Promise.resolve(
      new Map(this.rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row])),
    );
  }

  usingShift(shiftId: string): Promise<PatternWithDays[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.days.some((day) => day.shiftId === shiftId)),
    );
  }

  create(
    values: Omit<PatternRow, 'id'>,
    days: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays> {
    return Promise.resolve(this.seed({ ...values, days: [...days] }));
  }

  update(
    id: string,
    patch: Partial<PatternRow>,
    days?: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return Promise.resolve(null);
    Object.assign(row, patch);
    if (days) row.days = [...days];
    return Promise.resolve(row);
  }

  archive(id: string): Promise<boolean> {
    this.archived.push(id);
    return Promise.resolve(true);
  }

  archiveBlockers(): Promise<ArchiveBlocker[]> {
    return Promise.resolve(this.blockers);
  }

  assignedEmployeeCounts(ids: string[]): Promise<Map<string, number>> {
    return Promise.resolve(new Map(ids.map((id) => [id, 0])));
  }
}

export class FakeAssignments implements AssignmentRepositoryPort {
  rows: AssignmentRow[] = [];
  cancelled: { softDelete: string; reopen: { id: string; effectiveTo: string | null } | null }[] =
    [];

  seed(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
    const row: AssignmentRow = {
      id: nextId('assignment'),
      companyId: COMPANY,
      employeeId: EMPLOYEE,
      patternId: 'pattern-1',
      cycleAnchorDate: '2026-09-14',
      note: null,
      effectiveFrom: '2026-09-01',
      effectiveTo: null,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  liveHistory(employeeId: string): Promise<AssignmentRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.employeeId === employeeId));
  }

  history(employeeId: string): Promise<AssignmentRow[]> {
    return this.liveHistory(employeeId);
  }

  companyDefaultHistory(companyId: string): Promise<AssignmentRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.companyId === companyId && row.employeeId === null),
    );
  }

  findById(id: string): Promise<AssignmentRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  liveOn(employeeId: string, date: string): Promise<AssignmentRow | null> {
    return Promise.resolve(
      this.rows.find((row) => row.employeeId === employeeId && covers(row, date)) ?? null,
    );
  }

  liveOnForMany(employeeIds: string[], date: string): Promise<Map<string, AssignmentRow>> {
    const found = new Map<string, AssignmentRow>();
    for (const row of this.rows) {
      if (row.employeeId && employeeIds.includes(row.employeeId) && covers(row, date)) {
        found.set(row.employeeId, row);
      }
    }
    return Promise.resolve(found);
  }

  overlapping(employeeId: string, from: string, to: string): Promise<AssignmentRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.employeeId === employeeId &&
          row.effectiveFrom < to &&
          (row.effectiveTo === null || row.effectiveTo > from),
      ),
    );
  }

  defaultOn(companyId: string, date: string): Promise<AssignmentRow | null> {
    return Promise.resolve(
      this.rows.find(
        (row) => row.companyId === companyId && row.employeeId === null && covers(row, date),
      ) ?? null,
    );
  }

  defaultsOverlapping(companyId: string, from: string, to: string): Promise<AssignmentRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.companyId === companyId &&
          row.employeeId === null &&
          row.effectiveFrom < to &&
          (row.effectiveTo === null || row.effectiveTo > from),
      ),
    );
  }

  supersede(plan: {
    close: { id: string; effectiveTo: string } | null;
    insert: Omit<AssignmentRow, 'id'>;
  }): Promise<AssignmentRow> {
    if (plan.close) {
      const row = this.rows.find((candidate) => candidate.id === plan.close?.id);
      if (row) row.effectiveTo = plan.close.effectiveTo;
    }
    return Promise.resolve(this.seed(plan.insert));
  }

  cancel(plan: {
    softDelete: string;
    reopen: { id: string; effectiveTo: string | null } | null;
  }): Promise<void> {
    this.cancelled.push(plan);
    this.rows = this.rows.filter((row) => row.id !== plan.softDelete);
    if (plan.reopen) {
      const row = this.rows.find((candidate) => candidate.id === plan.reopen?.id);
      if (row) row.effectiveTo = plan.reopen.effectiveTo;
    }
    return Promise.resolve();
  }
}

export class FakeRosterDays implements RosterDayRepositoryPort {
  rows: RosterDayRow[] = [];

  seed(overrides: Partial<RosterDayRow> = {}): RosterDayRow {
    const row: RosterDayRow = {
      id: nextId('roster-day'),
      employeeId: EMPLOYEE,
      date: '2026-09-14',
      shiftId: null,
      worksOnHoliday: false,
      note: null,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  findFor(employeeId: string, date: string): Promise<RosterDayRow | null> {
    return Promise.resolve(
      this.rows.find((row) => row.employeeId === employeeId && row.date === date) ?? null,
    );
  }

  findById(id: string): Promise<RosterDayRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findRange(employeeId: string, from: string, to: string): Promise<RosterDayRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.employeeId === employeeId && row.date >= from && row.date < to),
    );
  }

  findRangeForMany(employeeIds: string[], from: string, to: string): Promise<RosterDayRow[]> {
    return Promise.resolve(
      this.rows.filter(
        (row) => employeeIds.includes(row.employeeId) && row.date >= from && row.date < to,
      ),
    );
  }

  upsert(values: Omit<RosterDayRow, 'id'>): Promise<RosterDayRow> {
    const existing = this.rows.find(
      (row) => row.employeeId === values.employeeId && row.date === values.date,
    );
    if (existing) {
      Object.assign(existing, values);
      return Promise.resolve(existing);
    }
    return Promise.resolve(this.seed(values));
  }

  softDelete(id: string): Promise<RosterDayRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    this.rows = this.rows.filter((candidate) => candidate.id !== id);
    return Promise.resolve(row ?? null);
  }

  countByShift(shiftId: string): Promise<number> {
    return Promise.resolve(this.rows.filter((row) => row.shiftId === shiftId).length);
  }

  usage(shiftId: string): Promise<{ employeeId: string; date: string }[]> {
    return Promise.resolve(
      this.rows
        .filter((row) => row.shiftId === shiftId)
        .map((row) => ({ employeeId: row.employeeId, date: row.date })),
    );
  }

  flaggedOn(dates: readonly string[]): Promise<RosterDayRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.worksOnHoliday && dates.includes(row.date)),
    );
  }
}

export class FakeEmployees implements EmployeeLookupPort {
  rows: EmployeeSummary[] = [];

  seed(overrides: Partial<EmployeeSummary> = {}): EmployeeSummary {
    const row: EmployeeSummary = {
      employeeId: EMPLOYEE,
      employeeNumber: 'EMP-0001',
      fullName: 'Budi',
      companyId: COMPANY,
      status: 'active',
      joinDate: '2020-01-01',
      userId: 'user-1',
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  find(employeeId: string): Promise<EmployeeSummary | null> {
    return Promise.resolve(this.rows.find((row) => row.employeeId === employeeId) ?? null);
  }

  findByUserId(userId: string): Promise<EmployeeSummary | null> {
    return Promise.resolve(this.rows.find((row) => row.userId === userId) ?? null);
  }

  findByNumber(employeeNumber: string): Promise<EmployeeSummary | null> {
    return Promise.resolve(this.rows.find((row) => row.employeeNumber === employeeNumber) ?? null);
  }

  findMany(employeeIds: string[]): Promise<Map<string, EmployeeSummary>> {
    return Promise.resolve(
      new Map(
        this.rows
          .filter((row) => employeeIds.includes(row.employeeId))
          .map((row) => [row.employeeId, row]),
      ),
    );
  }

  page(filter: { companyId: string }, page: Page): Promise<Paged<EmployeeSummary>> {
    const rows = this.rows.filter((row) => row.companyId === filter.companyId);
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }
}

export class FakeCache implements ScheduleCachePort {
  entries = new Map<string, ScheduledDay[]>();
  busted: string[] = [];
  reads = 0;

  read(tenantId: string, employeeId: string, month: string): Promise<ScheduledDay[] | null> {
    this.reads += 1;
    return Promise.resolve(this.entries.get(`${employeeId}:${month}`) ?? null);
  }

  write(
    tenantId: string,
    employeeId: string,
    month: string,
    days: readonly ScheduledDay[],
  ): Promise<void> {
    this.entries.set(`${employeeId}:${month}`, [...days]);
    return Promise.resolve();
  }

  bustEmployee(_tenantId: string, employeeId: string): Promise<void> {
    this.busted.push(employeeId);
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${employeeId}:`)) this.entries.delete(key);
    }
    return Promise.resolve();
  }

  bustEmployees(tenantId: string, employeeIds: readonly string[]): Promise<void> {
    return Promise.all(employeeIds.map((id) => this.bustEmployee(tenantId, id))).then(
      () => undefined,
    );
  }

  bustTenant(): Promise<void> {
    this.busted.push('*');
    this.entries.clear();
    return Promise.resolve();
  }
}

export class FakeOutbox implements ShiftOutboxPort {
  events: Parameters<ShiftOutboxPort['emit']>[0][] = [];

  emit(event: Parameters<ShiftOutboxPort['emit']>[0]): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export function fakeOrg(overrides: Partial<OrgQueryPort> = {}): OrgQueryPort {
  const placement = {
    companyId: COMPANY,
    companyName: 'Company',
    branchId: BRANCH,
    branchName: 'Head office',
    branchTimezone: 'Asia/Jakarta',
    departmentId: 'dep-1',
    departmentName: 'Ops',
    positionId: 'pos-1',
    positionTitle: 'Staff',
    jobLevelId: 'lvl-1',
    jobLevelName: 'Staff',
  };
  return {
    placement: () => Promise.resolve(placement),
    placements: (ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, placement]))),
    directReports: () => Promise.resolve([]),
    ...overrides,
  } as unknown as OrgQueryPort;
}

export function fakeHolidays(days: NonWorkingDay[] = []): HolidayQueryPort {
  return {
    dayType: (_companyId, _branchId, date) => {
      const day = days.find((candidate) => candidate.date === date);
      return Promise.resolve(
        day ? { working: false, holiday: { kind: day.kind, name: day.name } } : { working: true },
      );
    },
    nonWorkingDays: (_companyId, _branchId, from, to) =>
      Promise.resolve(days.filter((day) => day.date >= from && day.date < to)),
  };
}

export function fakePeriods(locked: LockedDate | null = null): PeriodLockPort {
  return {
    isLocked: (_companyId, date) => Promise.resolve(locked?.date === date),
    firstLockedDate: (_companyId: string, dates: string[]) =>
      Promise.resolve(locked && dates.includes(locked.date) ? locked : null),
  };
}

function covers(row: AssignmentRow, date: string): boolean {
  return row.effectiveFrom <= date && (row.effectiveTo === null || row.effectiveTo > date);
}
