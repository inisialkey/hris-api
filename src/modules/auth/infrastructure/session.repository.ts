import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { devices, sessions, users } from '../../../database/schema';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import type {
  NewSession,
  SessionListRow,
  SessionRecord,
  SessionRepositoryPort,
  SessionRevokedReason,
} from '../domain/auth.ports';

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
      deviceId: session.deviceId,
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

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.connection
      .handle()
      .select(RECORD_COLUMNS)
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return rows[0] ?? null;
  }

  async rotate(sessionId: string, newRefreshTokenHash: string, now: Date): Promise<void> {
    await this.connection
      .handle()
      .update(sessions)
      .set({ refreshTokenHash: newRefreshTokenHash, lastUsedAt: now })
      .where(eq(sessions.id, sessionId));
  }

  async revoke(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<boolean> {
    const revoked = await this.connection
      .handle()
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length > 0;
  }

  async revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));

    const revoked = await this.connection
      .handle()
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(...conditions))
      .returning({ id: sessions.id });
    return revoked.map((row) => row.id);
  }

  async revokeForDevice(deviceId: string, now: Date): Promise<string[]> {
    const revoked = await this.connection
      .handle()
      .update(sessions)
      .set({ revokedAt: now, revokedReason: 'device_revoked' })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.map((row) => row.id);
  }

  /**
   * The live list (UC-AUTH-004): revoked rows are hidden, expired rows stay
   * until the purge job (§9 — "a session list never shows a gap"), newest
   * first. `deviceSummary` joins the registry; NULL device = a web session, the
   * user agent carries the description.
   */
  async listForUser(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: SessionListRow[]; total: number }> {
    const db = this.connection.handle();
    const where = and(eq(sessions.userId, userId), isNull(sessions.revokedAt));

    const [rows, totals] = await Promise.all([
      db
        .select({
          id: sessions.id,
          deviceSummary: sql<
            string | null
          >`case when ${devices.id} is null then null else ${devices.model} || ' (' || ${devices.platform} || ')' end`,
          ip: sessions.ip,
          userAgent: sessions.userAgent,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          trustedDevice: sessions.trustedDevice,
        })
        .from(sessions)
        .leftJoin(devices, eq(sessions.deviceId, devices.id))
        .where(where)
        .orderBy(sql`${sessions.createdAt} desc`)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ total: count() }).from(sessions).where(where),
    ]);

    return { rows, total: totals[0]?.total ?? 0 };
  }

  async stampLastLogin(userId: string): Promise<void> {
    await this.connection
      .handle()
      .update(users)
      .set({ lastLoginAt: this.clock.now(), updatedBy: userId })
      .where(eq(users.id, userId));
  }
}

const RECORD_COLUMNS = {
  id: sessions.id,
  tenantId: sessions.tenantId,
  userId: sessions.userId,
  deviceId: sessions.deviceId,
  trustedDevice: sessions.trustedDevice,
  lastUsedAt: sessions.lastUsedAt,
  expiresAt: sessions.expiresAt,
  revokedAt: sessions.revokedAt,
  revokedReason: sessions.revokedReason,
};
