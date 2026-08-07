import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory } from '../../../database/schema';
import type { EmployeeLookupPort } from '../domain/organization.ports';

/**
 * The one read this module makes outside its own tables, through ADR-0001 rule
 * 6's **published view** rather than the base table.
 *
 * A placement needs the company it must agree with and the join date it must not
 * precede; both are `employee_directory` columns, neither is ADR-0016 encrypted
 * or BR-EMP-003 masked, and `security_invoker = true` means the read runs under
 * the caller's RLS. Retired the A-194 marker this class carried from 2026-08-06
 * to 2026-08-06 — the deviation lasted exactly as long as the module that
 * closed it took to arrive.
 *
 * It stays a port rather than becoming an import of employee's facade for the
 * reason ADR-0001 rule 3 gives: employee already consumes `OrgQueryPort` and
 * `OrgPlacementPort`, so a facade call back the other way would be a cycle. A
 * view is a schema object and creates none.
 */
@Injectable()
export class EmployeeLookupRepository implements EmployeeLookupPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async find(
    employeeId: string,
  ): Promise<{ id: string; companyId: string; joinDate: string } | null> {
    const rows = await this.connection
      .handle()
      .select({
        id: employeeDirectory.employeeId,
        companyId: employeeDirectory.companyId,
        joinDate: employeeDirectory.joinDate,
      })
      .from(employeeDirectory)
      .where(eq(employeeDirectory.employeeId, employeeId));
    return rows[0] ?? null;
  }

  async findByUserId(userId: string): Promise<{ id: string; companyId: string } | null> {
    const rows = await this.connection
      .handle()
      .select({ id: employeeDirectory.employeeId, companyId: employeeDirectory.companyId })
      .from(employeeDirectory)
      .where(eq(employeeDirectory.userId, userId));
    return rows[0] ?? null;
  }
}
