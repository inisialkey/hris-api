import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { users } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type { UserAccountRecord, UserAccountRepositoryPort } from '../domain/auth.ports';

/** The auth-owned writes to `users`, under the resolved tenant's context. */
@Injectable()
export class UserAccountRepository implements UserAccountRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async findById(userId: string): Promise<UserAccountRecord | null> {
    const rows = await this.connection
      .handle()
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  async findByEmail(email: string): Promise<UserAccountRecord | null> {
    const rows = await this.connection
      .handle()
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));
    return rows[0] ?? null;
  }

  async create(values: { email: string; passwordHash: string }): Promise<string> {
    const actorId = currentRequestContext()?.userId;
    const inserted = await this.connection
      .handle()
      .insert(users)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        email: values.email,
        passwordHash: values.passwordHash,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning({ id: users.id });

    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('user insert returned no row');
    return id;
  }

  /**
   * The port takes a reason and this write does not record one, deliberately:
   * `revoked_reason` lives on `sessions`, so the reason travels with the
   * revocation the caller performs next. Recording it twice would be a second
   * place to keep true.
   */
  async deactivate(userId: string): Promise<void> {
    await this.connection
      .handle()
      .update(users)
      .set({ status: 'inactive', updatedBy: currentRequestContext()?.userId })
      .where(eq(users.id, userId));
  }

  async setPasswordHash(userId: string, passwordHash: string, actorId: string): Promise<void> {
    await this.connection
      .handle()
      .update(users)
      .set({ passwordHash, updatedBy: actorId })
      .where(eq(users.id, userId));
  }

  async unlock(userId: string, actorId: string): Promise<boolean> {
    const unlocked = await this.connection
      .handle()
      .update(users)
      .set({ status: 'active', updatedBy: actorId })
      .where(and(eq(users.id, userId), eq(users.status, 'locked')))
      .returning({ id: users.id });
    return unlocked.length > 0;
  }
}
