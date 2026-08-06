import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import {
  branches,
  companies,
  departments,
  employees,
  positions,
  userRoles,
} from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import type { CompanyRepositoryPort, Page, Paged } from '../domain/organization.ports';
import type { ArchiveBlocker, CompanyRow } from '../domain/organization.types';

/**
 * `companies` is core-schema §7's table and this module owns it (organization.md
 * §4.1), so the legal-identity columns and every write to the row live here.
 *
 * No tenant predicate on reads — RLS supplies it (ADR-0002). The **company**
 * predicate is different and is supplied explicitly: it is data scope, not
 * tenancy, and BR-AUTHZ-009 puts it in the repository.
 */
@Injectable()
export class CompanyRepository extends TenantScopedRepository implements CompanyRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, companies, audit);
  }

  async list(
    filter: { q?: string; companyIds: string[] | null },
    page: Page,
  ): Promise<Paged<CompanyRow>> {
    const where = and(
      isNull(companies.deletedAt),
      filter.companyIds === null ? undefined : inArray(companies.id, orNone(filter.companyIds)),
      filter.q
        ? or(ilike(companies.name, `%${filter.q}%`), ilike(companies.code, `%${filter.q}%`))
        : undefined,
    );

    // Sequential, never `Promise.all`: the transaction rides one `pg` socket and
    // parallel statements on it interleave (coding-standards-nestjs §4).
    const rows = await this.db
      .select()
      .from(companies)
      .where(where)
      .orderBy(companies.code)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(companies).where(where);

    return { rows: rows.map(toCompany), total: totals[0]?.total ?? 0 };
  }

  async counts(
    companyIds: string[],
  ): Promise<Map<string, { branchCount: number; employeeCount: number }>> {
    const result = new Map<string, { branchCount: number; employeeCount: number }>();
    if (companyIds.length === 0) return result;

    const branchRows = await this.db
      .select({ companyId: branches.companyId, total: count() })
      .from(branches)
      .where(and(inArray(branches.companyId, companyIds), isNull(branches.deletedAt)))
      .groupBy(branches.companyId);
    // A-194: reads `employees` directly until employee.md publishes
    // `employee_directory` (ADR-0001 rule 6). One count, no columns.
    const employeeRows = await this.db
      .select({ companyId: employees.companyId, total: count() })
      .from(employees)
      .where(and(inArray(employees.companyId, companyIds), isNull(employees.deletedAt)))
      .groupBy(employees.companyId);

    for (const id of companyIds) result.set(id, { branchCount: 0, employeeCount: 0 });
    for (const row of branchRows) {
      const entry = result.get(row.companyId);
      if (entry) entry.branchCount = row.total;
    }
    for (const row of employeeRows) {
      const entry = result.get(row.companyId);
      if (entry) entry.employeeCount = row.total;
    }
    return result;
  }

  async findById(id: string): Promise<CompanyRow | null> {
    const row = await this.findRowById(id);
    return row ? toCompany(row as CompanySelect) : null;
  }

  async findByCode(code: string): Promise<CompanyRow | null> {
    const rows = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.code, code), isNull(companies.deletedAt)));
    const row = rows[0];
    return row ? toCompany(row) : null;
  }

  async create(values: Omit<CompanyRow, 'id' | 'updatedAt'>): Promise<CompanyRow> {
    return toCompany((await this.insertAudited({ ...values })) as CompanySelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<CompanyRow, 'id' | 'code'>>,
  ): Promise<CompanyRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toCompany(row as CompanySelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /**
   * BR-ORG-006's five blockers, **counted rather than merely detected**: §6 lists
   * them in the confirm dialog, so "something references this" is not a usable
   * answer. Dependents are removed by explicit acts first, never cascaded.
   */
  async archiveBlockers(id: string): Promise<ArchiveBlocker[]> {
    // A-194: `employees` and `user_roles` are read directly here — see `counts`.
    // `user_roles` is authorization-rbac's promise in §9 that a company cannot be
    // archived out from under a scoped assignment.
    const employeeRows = await this.countOf(
      employees,
      and(
        eq(employees.companyId, id),
        isNull(employees.deletedAt),
        inArray(employees.status, ['active', 'on_leave']),
      ),
    );
    const roleRows = await this.countOf(userRoles, eq(userRoles.companyId, id));
    const branchRows = await this.countOf(
      branches,
      and(eq(branches.companyId, id), isNull(branches.deletedAt)),
    );
    const departmentRows = await this.countOf(
      departments,
      and(eq(departments.companyId, id), isNull(departments.deletedAt)),
    );
    const positionRows = await this.countOf(
      positions,
      and(eq(positions.companyId, id), isNull(positions.deletedAt)),
    );

    return [
      { type: 'employee', count: employeeRows },
      { type: 'role_assignment', count: roleRows },
      { type: 'branch', count: branchRows },
      { type: 'department', count: departmentRows },
      { type: 'position', count: positionRows },
    ].filter((blocker) => blocker.count > 0);
  }

  private async countOf(
    table:
      typeof employees | typeof userRoles | typeof branches | typeof departments | typeof positions,
    where: SQL | undefined,
  ): Promise<number> {
    const rows = await this.db.select({ total: count() }).from(table).where(where);
    return rows[0]?.total ?? 0;
  }
}

type CompanySelect = typeof companies.$inferSelect;

function toCompany(row: CompanySelect): CompanyRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    legalName: row.legalName,
    npwp: row.npwp,
    address: row.address,
    phone: row.phone,
    updatedAt: row.updatedAt,
  };
}

/**
 * An empty scope list must match nothing. `inArray(col, [])` is a SQL error in
 * some drivers and an accidental `TRUE` in others, and either way a user with no
 * assignments would not get "no companies" — which is the only correct answer.
 */
export function orNone(ids: string[]): string[] {
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'];
}
