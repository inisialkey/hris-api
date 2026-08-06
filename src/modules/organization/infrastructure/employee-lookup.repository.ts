import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employees } from '../../../database/schema';
import type { EmployeeLookupPort } from '../domain/organization.ports';

/**
 * A-194 — the temporary binding.
 *
 * BR-ORG-002 needs two facts about an employee before it will place them: the
 * company a position and branch must agree with, and the join date a placement
 * must not precede. Both belong to `employees`, which employee.md owns and which
 * is spine order 3 — one behind this module.
 *
 * ADR-0001 rule 6 makes the port the default path, so the port is what this
 * module depends on; only the **binding** is local, and it is deliberately the
 * narrowest possible read (three columns, one row, no joins). When employee.md
 * arrives it exports the same shape from its facade and this class is deleted —
 * one provider line changes, no caller does.
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
        id: employees.id,
        companyId: employees.companyId,
        joinDate: employees.joinDate,
      })
      .from(employees)
      .where(and(eq(employees.id, employeeId), isNull(employees.deletedAt)));

    return rows[0] ?? null;
  }

  async findByUserId(userId: string): Promise<{ id: string; companyId: string } | null> {
    const rows = await this.connection
      .handle()
      .select({ id: employees.id, companyId: employees.companyId })
      .from(employees)
      .where(and(eq(employees.userId, userId), isNull(employees.deletedAt)));

    return rows[0] ?? null;
  }
}
