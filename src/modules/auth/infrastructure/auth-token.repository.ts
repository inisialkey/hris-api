import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { authTokens } from '../../../database/schema';
import type { AuthTokenRepositoryPort } from '../domain/auth.ports';

/** Reset and invite tokens (BR-AUTH-010), under the resolved tenant's context. */
@Injectable()
export class AuthTokenRepository implements AuthTokenRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async create(token: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    purpose: 'password_reset' | 'invite';
    expiresAt: Date;
    createdBy?: string;
  }): Promise<string> {
    const id = uuidv7();
    await this.connection.handle().insert(authTokens).values({
      id,
      tenantId: token.tenantId,
      userId: token.userId,
      tokenHash: token.tokenHash,
      purpose: token.purpose,
      expiresAt: token.expiresAt,
      // NULL for self-service requests (§4) — there is no authenticated actor.
      createdBy: token.createdBy,
      updatedBy: token.createdBy,
    });
    return id;
  }

  async consume(tokenId: string, now: Date): Promise<boolean> {
    const consumed = await this.connection
      .handle()
      .update(authTokens)
      .set({ usedAt: now })
      .where(and(eq(authTokens.id, tokenId), isNull(authTokens.usedAt)))
      .returning({ id: authTokens.id });
    return consumed.length > 0;
  }
}
