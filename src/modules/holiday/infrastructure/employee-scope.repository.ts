import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory } from '../../../database/schema';
import type { EmployeeScopePort } from '../domain/holiday.ports';

/**
 * The caller's own employment, read from **`employee_directory`** — ADR-0001
 * rule 6's published read-model view, which is the sanctioned channel for
 * exactly this: a non-sensitive identity column another module may join. The
 * `employees` table itself stays employee.md's, and dependency-lint keeps it
 * that way.
 *
 * `user_id` is the join because §7's `/resolved` and `/sync` answer *"my
 * scope"*, and a login is what the request carries. An account with no employee
 * row — a platform-created administrator who was never hired — resolves to
 * `null`, which the caller renders as the tenant-wide calendar rather than as an
 * error.
 */
@Injectable()
export class EmployeeScopeRepository implements EmployeeScopePort {
  constructor(private readonly connection: ConnectionProvider) {}

  async findByUserId(userId: string): Promise<{ employeeId: string; companyId: string } | null> {
    const rows = await this.connection
      .handle()
      .select({ employeeId: employeeDirectory.employeeId, companyId: employeeDirectory.companyId })
      .from(employeeDirectory)
      .where(eq(employeeDirectory.userId, userId));
    return rows[0] ?? null;
  }
}
