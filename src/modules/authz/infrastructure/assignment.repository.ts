import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';

import { REDIS } from '../../../cache/redis.module';
import { ConnectionProvider } from '../../../database/connection.provider';
import { permissions, rolePermissions, userRoles } from '../../../database/schema';
import { UnitOfWork } from '../../../database/unit-of-work';
import type {
  AssignmentQueryPort,
  AuthzTransactionPort,
  CachedAuthorization,
  PermissionCachePort,
  RoleAssignment,
} from '../application/ports/authz.ports';

/** ADR-0005: 60 s, plus an explicit bust on any role or assignment mutation. */
const CACHE_TTL_SECONDS = 60;

@Injectable()
export class AssignmentRepository implements AssignmentQueryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async findAssignments(userId: string): Promise<RoleAssignment[]> {
    return this.connection
      .handle()
      .select({ roleId: userRoles.roleId, companyId: userRoles.companyId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
  }

  async findPermissionKeys(roleIds: readonly string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.connection
      .handle()
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, [...roleIds]));
    return rows.map((r) => r.key);
  }
}

@Injectable()
export class PermissionCacheRedis implements PermissionCachePort {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(tenantId: string, userId: string): string {
    // naming §8 grammar; the `authz` namespace is this module's.
    return `hris:authz:${tenantId}:${userId}:permissions`;
  }

  async get(tenantId: string, userId: string): Promise<CachedAuthorization | null> {
    const raw = await this.redis.get(this.key(tenantId, userId));
    return raw === null ? null : (JSON.parse(raw) as CachedAuthorization);
  }

  async set(tenantId: string, userId: string, value: CachedAuthorization): Promise<void> {
    await this.redis.set(
      this.key(tenantId, userId),
      JSON.stringify(value),
      'EX',
      CACHE_TTL_SECONDS,
    );
  }

  async invalidate(tenantId: string, userId: string): Promise<void> {
    await this.redis.del(this.key(tenantId, userId));
  }
}

@Injectable()
export class AuthzTransactionAdapter implements AuthzTransactionPort {
  constructor(private readonly uow: UnitOfWork) {}

  async runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.uow.run({ tenantId, source: 'jwt' }, fn);
  }
}
