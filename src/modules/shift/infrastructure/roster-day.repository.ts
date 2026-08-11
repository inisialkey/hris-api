import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray, isNull, lt } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { rosterDays } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { RosterDayRepositoryPort } from '../domain/shift.ports';
import type { RosterDayRow } from '../domain/shift.types';

type RosterDaySelect = typeof rosterDays.$inferSelect;

@Injectable()
export class RosterDayRepository extends TenantScopedRepository implements RosterDayRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, rosterDays, audit);
  }

  async findFor(employeeId: string, date: string): Promise<RosterDayRow | null> {
    const rows = await this.db
      .select()
      .from(rosterDays)
      .where(
        and(
          eq(rosterDays.employeeId, employeeId),
          eq(rosterDays.date, date),
          isNull(rosterDays.deletedAt),
        ),
      );
    const row = rows[0];
    return row ? toRosterDay(row) : null;
  }

  async findById(id: string): Promise<RosterDayRow | null> {
    const row = await this.findRowById(id);
    return row ? toRosterDay(row as RosterDaySelect) : null;
  }

  async findRange(employeeId: string, from: string, to: string): Promise<RosterDayRow[]> {
    const rows = await this.db
      .select()
      .from(rosterDays)
      .where(
        and(
          eq(rosterDays.employeeId, employeeId),
          gte(rosterDays.date, from),
          lt(rosterDays.date, to),
          isNull(rosterDays.deletedAt),
        ),
      )
      .orderBy(rosterDays.date);
    return rows.map(toRosterDay);
  }

  async findRangeForMany(employeeIds: string[], from: string, to: string): Promise<RosterDayRow[]> {
    if (employeeIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(rosterDays)
      .where(
        and(
          inArray(rosterDays.employeeId, employeeIds),
          gte(rosterDays.date, from),
          lt(rosterDays.date, to),
          isNull(rosterDays.deletedAt),
        ),
      )
      .orderBy(rosterDays.date);
    return rows.map(toRosterDay);
  }

  /**
   * UC-SHF-005's paint. The natural key is `(employee_id, date)` and the unique
   * index is **partial**, so a previously cleared cell is repainted by inserting
   * beside its tombstone rather than by resurrecting it — the audit trail then
   * shows a delete and a create, which is what happened.
   */
  async upsert(values: Omit<RosterDayRow, 'id'>): Promise<RosterDayRow> {
    const existing = await this.findFor(values.employeeId, values.date);
    if (existing) {
      const updated = await this.updateAudited(existing.id, {
        shiftId: values.shiftId,
        worksOnHoliday: values.worksOnHoliday,
        note: values.note,
      });
      return toRosterDay(updated as RosterDaySelect);
    }
    return toRosterDay((await this.insertAudited({ ...values })) as RosterDaySelect);
  }

  async softDelete(id: string): Promise<RosterDayRow | null> {
    const row = await this.softDeleteAudited(id, this.clock.now());
    return row ? toRosterDay(row as RosterDaySelect) : null;
  }

  async countByShift(shiftId: string, from: string): Promise<number> {
    const rows = await this.db
      .select({ total: count() })
      .from(rosterDays)
      .where(
        and(
          eq(rosterDays.shiftId, shiftId),
          gte(rosterDays.date, from),
          isNull(rosterDays.deletedAt),
        ),
      );
    return rows[0]?.total ?? 0;
  }

  async usage(shiftId: string): Promise<{ employeeId: string; date: string }[]> {
    const rows = await this.db
      .select({ employeeId: rosterDays.employeeId, date: rosterDays.date })
      .from(rosterDays)
      .where(and(eq(rosterDays.shiftId, shiftId), isNull(rosterDays.deletedAt)))
      .orderBy(rosterDays.date);
    return rows;
  }

  async flaggedOn(dates: readonly string[]): Promise<RosterDayRow[]> {
    if (dates.length === 0) return [];
    const rows = await this.db
      .select()
      .from(rosterDays)
      .where(
        and(
          inArray(rosterDays.date, [...dates]),
          eq(rosterDays.worksOnHoliday, true),
          isNull(rosterDays.deletedAt),
        ),
      )
      .orderBy(rosterDays.date);
    return rows.map(toRosterDay);
  }
}

function toRosterDay(row: RosterDaySelect): RosterDayRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    date: row.date,
    shiftId: row.shiftId,
    worksOnHoliday: row.worksOnHoliday,
    note: row.note,
  };
}
