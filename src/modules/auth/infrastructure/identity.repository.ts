import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory, tenants, users } from '../../../database/schema';
import type { IdentityQueryPort } from '../application/ports/auth-services.port';

export interface IdentitySummary {
  email: string;
}

export interface TenantView {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
}

/** Reads for `/auth/me`, inside the request's tenant-scoped transaction. */
@Injectable()
export class IdentityRepository implements IdentityQueryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async findUser(userId: string): Promise<IdentitySummary | null> {
    const rows = await this.connection
      .handle()
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  /**
   * §7's `name` and `employeeId`. Through `employee_directory`, never through
   * `employees`: the view is ADR-0001 rule 6's sanctioned channel, its column
   * list carries nothing encrypted or masked, and `security_invoker = true`
   * keeps the read under the caller's RLS. Dependency-lint permits the view name
   * and keeps rejecting the table (A-195).
   */
  async findEmployeeIdentity(
    userId: string,
  ): Promise<{ employeeId: string; fullName: string } | null> {
    const rows = await this.connection
      .handle()
      .select({ employeeId: employeeDirectory.employeeId, fullName: employeeDirectory.fullName })
      .from(employeeDirectory)
      .where(eq(employeeDirectory.userId, userId));
    return rows[0] ?? null;
  }

  async findTenant(tenantId: string): Promise<TenantView | null> {
    const rows = await this.connection
      .handle()
      .select({ id: tenants.id, name: tenants.name, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return rows[0] ?? null;
  }
}
