/**
 * Fakes shared by this module's use-case specs — hand-written in-memory doubles,
 * per coding-standards-nestjs §9.
 *
 * The repository fake stores rows and applies the same live/soft-deleted rule the
 * real one does, because half of what these specs assert is a read the service
 * makes before a write: the duplicate check, the negation check, and the two
 * dates a moved row has to clear.
 */

import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { LockedDate, PeriodLockPort } from '../../../shared/period-lock.port';
import type { OrgQueryPort } from '../../organization';
import type {
  EmployeeScopePort,
  HolidayCachePort,
  HolidayListFilter,
  HolidayOutboxPort,
  HolidayRepositoryPort,
  NewHoliday,
  SyncCursor,
} from '../domain/holiday.ports';
import type { HolidayRow, HolidayScope, Page, Paged } from '../domain/holiday.types';
import type { ResolvableRow } from '../domain/resolve';

export const TENANT = '018f2f4a-0000-7000-8000-0000000b0001';
export const COMPANY = '018f2f4a-0000-7000-8000-0000000b0002';
export const BRANCH = '018f2f4a-0000-7000-8000-0000000b0003';
export const NOW = new Date('2026-08-11T03:00:00Z');
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

export class FakeHolidays implements HolidayRepositoryPort {
  rows: HolidayRow[] = [];

  seed(values: Partial<HolidayRow> = {}): HolidayRow {
    sequence += 1;
    const row: HolidayRow = {
      id: `holiday-${sequence}`,
      companyId: null,
      branchId: null,
      date: '2026-05-01',
      name: 'National day A',
      kind: 'national',
      observed: true,
      createdBy: 'user-1',
      updatedAt: NOW,
      deletedAt: null,
      ...values,
    };
    this.rows.push(row);
    return row;
  }

  list(filter: HolidayListFilter, page: Page): Promise<Paged<HolidayRow>> {
    const rows = this.live().filter(
      (row) =>
        row.date.startsWith(String(filter.year)) &&
        (!filter.companyId || row.companyId === filter.companyId) &&
        (!filter.kind || row.kind === filter.kind),
    );
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }

  findById(id: string): Promise<HolidayRow | null> {
    return Promise.resolve(this.live().find((row) => row.id === id) ?? null);
  }

  inRange(from: string, to: string): Promise<HolidayRow[]> {
    return Promise.resolve(this.live().filter((row) => row.date >= from && row.date < to));
  }

  create(values: NewHoliday): Promise<HolidayRow> {
    return Promise.resolve(this.seed(values));
  }

  update(
    id: string,
    patch: Partial<Pick<HolidayRow, 'name' | 'date' | 'observed'>>,
  ): Promise<HolidayRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id && !candidate.deletedAt);
    if (!row) return Promise.resolve(null);
    Object.assign(row, patch);
    return Promise.resolve(row);
  }

  softDelete(id: string): Promise<HolidayRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id && !candidate.deletedAt);
    if (!row) return Promise.resolve(null);
    row.deletedAt = NOW;
    return Promise.resolve(row);
  }

  changedSince(
    _scope: HolidayScope,
    _updatedSince: Date | null,
    _cursor: SyncCursor | null,
    limit: number,
  ): Promise<HolidayRow[]> {
    return Promise.resolve(this.rows.slice(0, limit));
  }

  private live(): HolidayRow[] {
    return this.rows.filter((row) => !row.deletedAt);
  }
}

export class FakeCache implements HolidayCachePort {
  busted: string[] = [];
  entries = new Map<string, ResolvableRow[]>();
  reads = 0;

  read(tenantId: string, month: string): Promise<ResolvableRow[] | null> {
    this.reads += 1;
    return Promise.resolve(this.entries.get(`${tenantId}:${month}`) ?? null);
  }

  write(tenantId: string, month: string, rows: readonly ResolvableRow[]): Promise<void> {
    this.entries.set(`${tenantId}:${month}`, [...rows]);
    return Promise.resolve();
  }

  bust(_tenantId: string, months: readonly string[]): Promise<void> {
    this.busted.push(...months);
    return Promise.resolve();
  }
}

export class FakeOutbox implements HolidayOutboxPort {
  events: Parameters<HolidayOutboxPort['emit']>[0][] = [];

  emit(event: Parameters<HolidayOutboxPort['emit']>[0]): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export function fakeOrg(overrides: Partial<OrgQueryPort> = {}): OrgQueryPort {
  return {
    branchCompanyId: (branchId: string) => Promise.resolve(branchId === BRANCH ? COMPANY : null),
    companyIds: () => Promise.resolve([COMPANY]),
    placement: () => Promise.resolve(null),
    ...overrides,
  } as unknown as OrgQueryPort;
}

export function fakePeriods(locked: LockedDate | null = null): PeriodLockPort {
  return {
    isLocked: () => Promise.resolve(locked !== null),
    firstLockedDate: (_companyId: string, dates: string[]) =>
      Promise.resolve(locked && dates.includes(locked.date) ? locked : null),
  };
}

export function fakeEmployeeScope(
  employee: { employeeId: string; companyId: string } | null = null,
): EmployeeScopePort {
  return { findByUserId: () => Promise.resolve(employee) };
}
