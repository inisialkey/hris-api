import { Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { roles, userRoles } from '../../../database/schema';
import type { RoleHolderPort } from '../domain/role-holder.port';

/**
 * `RoleHolderPort`'s implementation. No tenant predicate on the reads — RLS
 * supplies it (ADR-0002), and these three statements run inside the caller's
 * unit of work, which is the approval engine's activation transaction.
 */
@Injectable()
export class RoleRepository implements RoleHolderPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async holderUserIds(roleId: string, companyId: string): Promise<string[]> {
    const rows = await this.connection
      .handle()
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          eq(userRoles.roleId, roleId),
          // `company_id IS NULL` is the tenant-wide grant, not "no company".
          or(isNull(userRoles.companyId), eq(userRoles.companyId, companyId)),
          isNull(roles.deletedAt),
        ),
      );
    return [...new Set(rows.map((row) => row.userId))];
  }

  async findIdByKey(key: string): Promise<string | null> {
    const rows = await this.connection
      .handle()
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.key, key), isNull(roles.deletedAt)));
    return rows[0]?.id ?? null;
  }

  async exists(roleId: string): Promise<boolean> {
    const rows = await this.connection
      .handle()
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)));
    return rows.length > 0;
  }
}
