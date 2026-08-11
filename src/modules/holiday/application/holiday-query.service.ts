import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import {
  HOLIDAY_CACHE,
  HOLIDAY_REPOSITORY,
  type HolidayCachePort,
  type HolidayQueryPort,
  type HolidayRepositoryPort,
} from '../domain/holiday.ports';
import type { DayType, HolidayRow, NonWorkingDay } from '../domain/holiday.types';
import { monthOf, monthStart, monthsBetween, nextMonth } from '../domain/months';
import { resolveDate, resolveRange, type ResolvableRow } from '../domain/resolve';

/**
 * UC-HOL-001 — the port every time-math module calls, and the only place the
 * cache and the reducer meet.
 *
 * Attendance derivation reaches `dayType` **through** `ShiftQueryPort`, which
 * applies suppression once when it resolves a scheduled day (holiday.md §5,
 * shift.md BR-SHF-004): one question, one answer, no second opinion. That is why
 * this service has no notion of a shift and never will.
 */
@Injectable()
export class HolidayQueryService implements HolidayQueryPort {
  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepositoryPort,
    @Inject(HOLIDAY_CACHE) private readonly cache: HolidayCachePort,
  ) {}

  async dayType(companyId: string, branchId: string | null, date: string): Promise<DayType> {
    const rows = await this.monthRows(monthOf(date));
    return resolveDate(rows, { companyId, branchId }, date);
  }

  async nonWorkingDays(
    companyId: string,
    branchId: string | null,
    from: string,
    to: string,
  ): Promise<NonWorkingDay[]> {
    return resolveRange(await this.rowsBetween(from, to), { companyId, branchId }, from, to);
  }

  /** The rows behind `[from, to)`, month by month so every read shares the cache. */
  async rowsBetween(from: string, to: string): Promise<ResolvableRow[]> {
    const rows: ResolvableRow[] = [];
    // Sequential: these are cache reads and repository calls inside one
    // transaction, and one transaction is one socket (coding-standards §4).
    for (const month of monthsBetween(from, to)) rows.push(...(await this.monthRows(month)));
    return rows;
  }

  private async monthRows(month: string): Promise<ResolvableRow[]> {
    const tenantId = requireTenantContext().tenantId;

    const cached = await this.cache.read(tenantId, month);
    if (cached) return cached;

    const rows = (await this.holidays.inRange(monthStart(month), monthStart(nextMonth(month)))).map(
      toResolvable,
    );
    await this.cache.write(tenantId, month, rows);
    return rows;
  }
}

/**
 * The reducer's input is deliberately narrower than the row: no id, no audit
 * columns, no `Date`. It is what the mobile mirror carries, and it is what
 * survives a JSON round trip through Redis without a revival step.
 */
function toResolvable(row: HolidayRow): ResolvableRow {
  return {
    companyId: row.companyId,
    branchId: row.branchId,
    date: row.date,
    name: row.name,
    kind: row.kind,
    observed: row.observed,
  };
}
