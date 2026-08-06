import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { users } from '../../../database/schema';
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
