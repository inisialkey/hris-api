import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, ilike, inArray, isNull, lt, or } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { rosterDays, shiftPatternDays, shifts } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { NewShift, ShiftRepositoryPort } from '../domain/shift.ports';
import type { ArchiveBlocker, Page, Paged, ShiftRow } from '../domain/shift.types';

type ShiftSelect = typeof shifts.$inferSelect;

@Injectable()
export class ShiftRepository extends TenantScopedRepository implements ShiftRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, shifts, audit);
  }

  async list(filter: { companyId: string; q?: string }, page: Page): Promise<Paged<ShiftRow>> {
    const where = and(
      eq(shifts.companyId, filter.companyId),
      isNull(shifts.deletedAt),
      filter.q
        ? or(ilike(shifts.name, `%${filter.q}%`), ilike(shifts.code, `%${filter.q}%`))
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(shifts)
      .where(where)
      .orderBy(shifts.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(shifts).where(where);

    return { rows: rows.map(toShift), total: totals[0]?.total ?? 0 };
  }

  async findById(id: string): Promise<ShiftRow | null> {
    const row = await this.findRowById(id);
    return row ? toShift(row as ShiftSelect) : null;
  }

  async findByCode(companyId: string, code: string): Promise<ShiftRow | null> {
    const rows = await this.db
      .select()
      .from(shifts)
      .where(and(eq(shifts.companyId, companyId), eq(shifts.code, code), isNull(shifts.deletedAt)));
    const row = rows[0];
    return row ? toShift(row) : null;
  }

  async findManyByIds(ids: string[]): Promise<Map<string, ShiftRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(shifts)
      .where(and(inArray(shifts.id, ids), isNull(shifts.deletedAt)));
    return new Map(rows.map((row) => [row.id, toShift(row)]));
  }

  async findAllByCompany(companyId: string): Promise<Map<string, ShiftRow>> {
    const rows = await this.db
      .select()
      .from(shifts)
      .where(and(eq(shifts.companyId, companyId), isNull(shifts.deletedAt)));
    return new Map(rows.map((row) => [row.id, toShift(row)]));
  }

  async create(values: NewShift): Promise<ShiftRow> {
    return toShift((await this.insertAudited({ ...values })) as ShiftSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<ShiftRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<ShiftRow | null> {
    const row = await this.updateAudited(id, patch);
    return row ? toShift(row as ShiftSelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /** BR-SHF-011 — live pattern entries and live/future roster days, counted separately. */
  async archiveBlockers(id: string, today: string): Promise<ArchiveBlocker[]> {
    const blockers: ArchiveBlocker[] = [];

    const patternEntries = await this.db
      .select({ total: count() })
      .from(shiftPatternDays)
      .where(eq(shiftPatternDays.shiftId, id));
    const entries = patternEntries[0]?.total ?? 0;
    if (entries > 0) blockers.push({ type: 'shift_pattern_days', count: entries });

    const days = await this.db
      .select({ total: count() })
      .from(rosterDays)
      .where(
        and(eq(rosterDays.shiftId, id), gte(rosterDays.date, today), isNull(rosterDays.deletedAt)),
      );
    const future = days[0]?.total ?? 0;
    if (future > 0) blockers.push({ type: 'roster_days', count: future });

    return blockers;
  }

  /** §7's `usageCount`: live pattern entries + roster days inside the preview horizon. */
  async usageCounts(ids: string[], today: string, horizon: string): Promise<Map<string, number>> {
    const counts = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return counts;

    const entries = await this.db
      .select({ shiftId: shiftPatternDays.shiftId, total: count() })
      .from(shiftPatternDays)
      .where(inArray(shiftPatternDays.shiftId, ids))
      .groupBy(shiftPatternDays.shiftId);
    for (const row of entries) {
      if (row.shiftId) counts.set(row.shiftId, (counts.get(row.shiftId) ?? 0) + row.total);
    }

    const days = await this.db
      .select({ shiftId: rosterDays.shiftId, total: count() })
      .from(rosterDays)
      .where(
        and(
          inArray(rosterDays.shiftId, ids),
          gte(rosterDays.date, today),
          lt(rosterDays.date, horizon),
          isNull(rosterDays.deletedAt),
        ),
      )
      .groupBy(rosterDays.shiftId);
    for (const row of days) {
      if (row.shiftId) counts.set(row.shiftId, (counts.get(row.shiftId) ?? 0) + row.total);
    }

    return counts;
  }
}

/** Exported: the pattern repository maps the same rows. */
export function toShift(row: ShiftSelect): ShiftRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    breakStartTime: row.breakStartTime,
    lateToleranceMinutes: row.lateToleranceMinutes,
    earlyLeaveToleranceMinutes: row.earlyLeaveToleranceMinutes,
    punchInBeforeMinutes: row.punchInBeforeMinutes,
    punchOutAfterMinutes: row.punchOutAfterMinutes,
    color: row.color,
  };
}
