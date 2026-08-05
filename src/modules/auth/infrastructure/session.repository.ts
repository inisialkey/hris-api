import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { sessions, users } from '../../../database/schema';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import type { NewSession, SessionRepositoryPort } from '../domain/auth.ports';

export interface LiveSession {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

/**
 * Sessions, under the resolved tenant's context.
 *
 * Every method here runs inside a unit-of-work whose first statement set
 * `app.tenant_id`, so the tenant predicate is enforced twice: the caller's
 * context supplies it on the write, and the RLS policy's `WITH CHECK` refuses a
 * row that disagrees. A payload smuggling another tenant's id is rejected by the
 * database, not by a code review (leak test L3).
 */
@Injectable()
export class SessionRepository implements SessionRepositoryPort {
  constructor(
    private readonly connection: ConnectionProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(session: NewSession): Promise<string> {
    const id = uuidv7();
    await this.connection.handle().insert(sessions).values({
      id,
      tenantId: session.tenantId,
      userId: session.userId,
      refreshTokenHash: session.refreshTokenHash,
      trustedDevice: session.trustedDevice,
      ip: session.ip,
      userAgent: session.userAgent,
      expiresAt: session.expiresAt,
      createdBy: session.userId,
      updatedBy: session.userId,
    });
    return id;
  }

  /**
   * BR-AUTH-006's liveness predicate, minus the sliding window.
   *
   * The sliding half needs `last_used_at + auth.refresh_sliding_lifetime`, and
   * that setting arrives with the settings module. Until then this checks the
   * two halves that are already expressible — not revoked, and inside the
   * absolute cap — which is a *narrower* liveness test than the rule, so it can
   * only reject sessions the full predicate would also reject.
   */
  async findLive(sessionId: string): Promise<LiveSession | null> {
    const rows = await this.connection
      .handle()
      .select({
        id: sessions.id,
        userId: sessions.userId,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

    const row = rows[0];
    if (!row) return null;
    return row.expiresAt > this.clock.now() ? row : null;
  }

  async stampLastLogin(userId: string): Promise<void> {
    await this.connection
      .handle()
      .update(users)
      .set({ lastLoginAt: this.clock.now(), updatedBy: userId })
      .where(eq(users.id, userId));
  }
}
