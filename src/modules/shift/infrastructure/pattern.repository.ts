import { Inject, Injectable } from '@nestjs/common';
import { and, count, countDistinct, eq, gte, ilike, inArray, isNull, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { rosterAssignments, shiftPatternDays, shiftPatterns } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { PatternRepositoryPort } from '../domain/shift.ports';
import type {
  ArchiveBlocker,
  Page,
  Paged,
  PatternRow,
  PatternWithDays,
} from '../domain/shift.types';

type PatternSelect = typeof shiftPatterns.$inferSelect;

@Injectable()
export class PatternRepository extends TenantScopedRepository implements PatternRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, shiftPatterns, audit);
  }

  async list(
    filter: { companyId: string; q?: string },
    page: Page,
  ): Promise<Paged<PatternWithDays>> {
    const where = and(
      eq(shiftPatterns.companyId, filter.companyId),
      isNull(shiftPatterns.deletedAt),
      filter.q
        ? or(ilike(shiftPatterns.name, `%${filter.q}%`), ilike(shiftPatterns.code, `%${filter.q}%`))
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(shiftPatterns)
      .where(where)
      .orderBy(shiftPatterns.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(shiftPatterns).where(where);
    const days = await this.daysFor(rows.map((row) => row.id));

    return {
      rows: rows.map((row) => ({ ...toPattern(row), days: days.get(row.id) ?? [] })),
      total: totals[0]?.total ?? 0,
    };
  }

  async findById(id: string): Promise<PatternWithDays | null> {
    const row = await this.findRowById(id);
    if (!row) return null;
    const days = await this.daysFor([id]);
    return { ...toPattern(row as PatternSelect), days: days.get(id) ?? [] };
  }

  async findByCode(companyId: string, code: string): Promise<PatternRow | null> {
    const rows = await this.db
      .select()
      .from(shiftPatterns)
      .where(
        and(
          eq(shiftPatterns.companyId, companyId),
          eq(shiftPatterns.code, code),
          isNull(shiftPatterns.deletedAt),
        ),
      );
    const row = rows[0];
    return row ? toPattern(row) : null;
  }

  async findManyByIds(ids: string[]): Promise<Map<string, PatternWithDays>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(shiftPatterns)
      .where(and(inArray(shiftPatterns.id, ids), isNull(shiftPatterns.deletedAt)));
    const days = await this.daysFor(rows.map((row) => row.id));
    return new Map(
      rows.map((row) => [row.id, { ...toPattern(row), days: days.get(row.id) ?? [] }]),
    );
  }

  async usingShift(shiftId: string): Promise<PatternWithDays[]> {
    const ids = await this.db
      .selectDistinct({ patternId: shiftPatternDays.patternId })
      .from(shiftPatternDays)
      .where(eq(shiftPatternDays.shiftId, shiftId));
    return [...(await this.findManyByIds(ids.map((row) => row.patternId))).values()];
  }

  /**
   * UC-SHF-003's replace-all. The days carry no identity of their own (§4.1 —
   * hard delete), so a save is a delete-then-insert **inside the caller's
   * transaction**: the unit of work is already open, and a cycle that is briefly
   * half-written is a cycle the resolver could read.
   */
  async create(
    values: Omit<PatternRow, 'id'>,
    days: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays> {
    const row = (await this.insertAudited({ ...values })) as PatternSelect;
    await this.replaceDays(row.id, days);
    return { ...toPattern(row), days: [...days] };
  }

  async update(
    id: string,
    patch: Partial<Pick<PatternRow, 'name' | 'observesHolidays' | 'cycleLength'>>,
    days?: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<PatternWithDays | null> {
    const row = await this.updateAudited(id, patch);
    if (!row) return null;
    if (days) await this.replaceDays(id, days);
    const stored = await this.daysFor([id]);
    return { ...toPattern(row as PatternSelect), days: stored.get(id) ?? [] };
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /** BR-SHF-011 — live or future assignments block the archive. */
  async archiveBlockers(id: string, today: string): Promise<ArchiveBlocker[]> {
    const rows = await this.db
      .select({ total: count() })
      .from(rosterAssignments)
      .where(
        and(
          eq(rosterAssignments.patternId, id),
          isNull(rosterAssignments.deletedAt),
          or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, today)),
        ),
      );
    const total = rows[0]?.total ?? 0;
    return total > 0 ? [{ type: 'roster_assignments', count: total }] : [];
  }

  /** §7's `assignedEmployeeCount` — distinct employees on a live or future row. */
  async assignedEmployeeCounts(ids: string[], today: string): Promise<Map<string, number>> {
    const counts = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return counts;

    const rows = await this.db
      .select({
        patternId: rosterAssignments.patternId,
        total: countDistinct(rosterAssignments.employeeId),
      })
      .from(rosterAssignments)
      .where(
        and(
          inArray(rosterAssignments.patternId, ids),
          isNull(rosterAssignments.deletedAt),
          or(isNull(rosterAssignments.effectiveTo), gte(rosterAssignments.effectiveTo, today)),
        ),
      )
      .groupBy(rosterAssignments.patternId);

    for (const row of rows) counts.set(row.patternId, row.total);
    return counts;
  }

  private async replaceDays(
    patternId: string,
    days: readonly { dayIndex: number; shiftId: string | null }[],
  ): Promise<void> {
    await this.db.delete(shiftPatternDays).where(eq(shiftPatternDays.patternId, patternId));
    if (days.length === 0) return;

    const actor = currentRequestContext()?.userId;
    await this.db.insert(shiftPatternDays).values(
      days.map((day) => ({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        patternId,
        dayIndex: day.dayIndex,
        shiftId: day.shiftId,
        createdBy: actor,
        updatedBy: actor,
      })),
    );
  }

  private async daysFor(
    patternIds: string[],
  ): Promise<Map<string, { dayIndex: number; shiftId: string | null }[]>> {
    const grouped = new Map<string, { dayIndex: number; shiftId: string | null }[]>();
    if (patternIds.length === 0) return grouped;

    const rows = await this.db
      .select()
      .from(shiftPatternDays)
      .where(inArray(shiftPatternDays.patternId, patternIds))
      .orderBy(shiftPatternDays.dayIndex);

    for (const row of rows) {
      const list = grouped.get(row.patternId) ?? [];
      list.push({ dayIndex: row.dayIndex, shiftId: row.shiftId });
      grouped.set(row.patternId, list);
    }
    return grouped;
  }
}

function toPattern(row: PatternSelect): PatternRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    cycleLength: row.cycleLength,
    observesHolidays: row.observesHolidays,
  };
}
