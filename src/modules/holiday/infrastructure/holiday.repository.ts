import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { holidays } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type {
  HolidayListFilter,
  HolidayRepositoryPort,
  NewHoliday,
  SyncCursor,
} from '../domain/holiday.ports';
import type { HolidayRow, HolidayScope, Page, Paged } from '../domain/holiday.types';

type HolidaySelect = typeof holidays.$inferSelect;

@Injectable()
export class HolidayRepository extends TenantScopedRepository implements HolidayRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, holidays, audit);
  }

  async list(filter: HolidayListFilter, page: Page): Promise<Paged<HolidayRow>> {
    const where = and(
      gte(holidays.date, `${filter.year}-01-01`),
      lt(holidays.date, `${filter.year + 1}-01-01`),
      isNull(holidays.deletedAt),
      filter.companyId ? eq(holidays.companyId, filter.companyId) : undefined,
      filter.branchId ? eq(holidays.branchId, filter.branchId) : undefined,
      filter.kind ? eq(holidays.kind, filter.kind) : undefined,
      // A company-scoped admin sees their companies' rows **and** the tenant-wide
      // ones those rows may negate — a calendar showing the negation without the
      // day it negates is unreadable (§6's origin chips).
      filter.companyIds
        ? or(isNull(holidays.companyId), inArray(holidays.companyId, filter.companyIds))
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(holidays)
      .where(where)
      .orderBy(asc(holidays.date), asc(holidays.kind), asc(holidays.id))
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(holidays).where(where);

    return { rows: rows.map(toHoliday), total: totals[0]?.total ?? 0 };
  }

  async findById(id: string): Promise<HolidayRow | null> {
    const row = await this.findRowById(id);
    return row ? toHoliday(row as HolidaySelect) : null;
  }

  async inRange(from: string, to: string): Promise<HolidayRow[]> {
    const rows = await this.db
      .select()
      .from(holidays)
      .where(and(gte(holidays.date, from), lt(holidays.date, to), isNull(holidays.deletedAt)))
      .orderBy(asc(holidays.date), asc(holidays.id));
    return rows.map(toHoliday);
  }

  async create(values: NewHoliday): Promise<HolidayRow> {
    const row = await this.insertAudited({ ...values });
    return toHoliday(row as HolidaySelect);
  }

  async update(
    id: string,
    patch: Partial<Pick<HolidayRow, 'name' | 'date' | 'observed'>>,
  ): Promise<HolidayRow | null> {
    const row = await this.updateAudited(id, patch);
    return row ? toHoliday(row as HolidaySelect) : null;
  }

  async softDelete(id: string): Promise<HolidayRow | null> {
    const row = await this.softDeleteAudited(id, this.clock.now());
    return row ? toHoliday(row as HolidaySelect) : null;
  }

  /**
   * §7's `/sync`. Soft-deleted rows are **included** — they are the tombstones a
   * device evicts on (api-standards §8), so this is the one read here that does
   * not filter on `deleted_at`.
   */
  async changedSince(
    scope: HolidayScope,
    updatedSince: Date | null,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<HolidayRow[]> {
    const rows = await this.db
      .select()
      .from(holidays)
      .where(
        and(
          inScope(scope),
          updatedSince ? gte(holidays.updatedAt, updatedSince) : undefined,
          // The position is re-read from the row rather than sent back in
          // milliseconds (see `SyncCursor`). A cursor naming a row this tenant
          // cannot see yields NULL and therefore an empty page — the device
          // restarts from its `updatedSince` high-water mark, which is the same
          // recovery api-standards §5.3 gives an expired cursor.
          cursor
            ? sql`(${holidays.updatedAt}, ${holidays.id}) > (SELECT c.updated_at, c.id FROM holidays c WHERE c.id = ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(asc(holidays.updatedAt), asc(holidays.id))
      .limit(limit);
    return rows.map(toHoliday);
  }
}

/** BR-HOL-002's scope chain as a predicate: tenant-wide + own company + own branch. */
function inScope(scope: HolidayScope) {
  if (scope.companyId === null) return isNull(holidays.companyId);
  return or(
    isNull(holidays.companyId),
    and(
      eq(holidays.companyId, scope.companyId),
      scope.branchId === null
        ? isNull(holidays.branchId)
        : or(isNull(holidays.branchId), eq(holidays.branchId, scope.branchId)),
    ),
  );
}

function toHoliday(row: HolidaySelect): HolidayRow {
  return {
    id: row.id,
    companyId: row.companyId,
    branchId: row.branchId,
    date: row.date,
    name: row.name,
    kind: row.kind,
    observed: row.observed,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
