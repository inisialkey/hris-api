import { Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, not, or } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory } from '../../../database/schema';
import type { EmployeeLookupPort, EmployeeSummary } from '../domain/shift.ports';
import type { Page, Paged } from '../domain/shift.types';

/** §9: terminal employees are hidden from the grid by default. */
const TERMINAL = ['resigned', 'terminated'] as const;

/**
 * Every identity read this module makes, through **`employee_directory`** —
 * ADR-0001 rule 6's published view.
 *
 * The grid is why the view exists in its amended form: `?q=` filters and sorts on
 * a name **before** the page boundary, and a query port returning rows after
 * pagination structurally cannot serve that.
 */
@Injectable()
export class EmployeeLookupRepository implements EmployeeLookupPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  async find(employeeId: string): Promise<EmployeeSummary | null> {
    const rows = await this.db
      .select(columns)
      .from(employeeDirectory)
      .where(eq(employeeDirectory.employeeId, employeeId));
    return rows[0] ?? null;
  }

  async findByUserId(userId: string): Promise<EmployeeSummary | null> {
    const rows = await this.db
      .select(columns)
      .from(employeeDirectory)
      .where(eq(employeeDirectory.userId, userId));
    return rows[0] ?? null;
  }

  async findByNumber(employeeNumber: string): Promise<EmployeeSummary | null> {
    const rows = await this.db
      .select(columns)
      .from(employeeDirectory)
      .where(eq(employeeDirectory.employeeNumber, employeeNumber));
    return rows[0] ?? null;
  }

  async findMany(employeeIds: string[]): Promise<Map<string, EmployeeSummary>> {
    if (employeeIds.length === 0) return new Map();
    const rows = await this.db
      .select(columns)
      .from(employeeDirectory)
      .where(inArray(employeeDirectory.employeeId, employeeIds));
    return new Map(rows.map((row) => [row.employeeId, row]));
  }

  async page(
    filter: { companyId: string; employeeId?: string; q?: string; includeTerminal?: boolean },
    page: Page,
  ): Promise<Paged<EmployeeSummary>> {
    const where = and(
      eq(employeeDirectory.companyId, filter.companyId),
      filter.employeeId ? eq(employeeDirectory.employeeId, filter.employeeId) : undefined,
      filter.includeTerminal ? undefined : not(inArray(employeeDirectory.status, TERMINAL)),
      filter.q
        ? or(
            ilike(employeeDirectory.fullName, `%${filter.q}%`),
            ilike(employeeDirectory.employeeNumber, `%${filter.q}%`),
          )
        : undefined,
    );

    const rows = await this.db
      .select(columns)
      .from(employeeDirectory)
      .where(where)
      // api-standards §4.1: every sort ends in a deterministic tiebreaker, or an
      // offset page shuffles between requests.
      .orderBy(employeeDirectory.fullName, employeeDirectory.employeeId)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(employeeDirectory).where(where);

    return { rows, total: totals[0]?.total ?? 0 };
  }
}

const columns = {
  employeeId: employeeDirectory.employeeId,
  employeeNumber: employeeDirectory.employeeNumber,
  fullName: employeeDirectory.fullName,
  companyId: employeeDirectory.companyId,
  status: employeeDirectory.status,
  joinDate: employeeDirectory.joinDate,
  userId: employeeDirectory.userId,
};
