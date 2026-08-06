import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import {
  AUTH_OUTBOX,
  SESSION_REPOSITORY,
  type AuthOutboxPort,
  type SessionListRow,
  type SessionRepositoryPort,
  type SessionRevokedReason,
} from '../domain/auth.ports';

/**
 * Who is acting, built by the controller from the request context.
 * `canActOnOthers` answers the endpoint's own permission key
 * (`auth.session.read` / `auth.session.revoke` / device twins) and is a thunk
 * so the ADR-0005 lazy rule holds: an own-scope call never pays the resolution.
 */
export interface SessionActor {
  tenantId: string;
  userId: string;
  sessionId: string;
  canActOnOthers: () => Promise<boolean>;
}

export interface SessionListItem extends SessionListRow {
  current: boolean;
}

export interface SessionPage {
  rows: SessionListItem[];
  total: number;
}

/**
 * UC-AUTH-003 (logout) and UC-AUTH-004 (session management). Runs inside the
 * request's tenant transaction — the interceptor opened it, RLS scopes it.
 */
@Injectable()
export class SessionUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(AUTH_OUTBOX) private readonly outbox: AuthOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Idempotent: logging out a dead session still returns success (UC-AUTH-003). */
  async logout(actor: SessionActor): Promise<Result<{ id: string }>> {
    await this.revokeWithEvent(actor.tenantId, actor.sessionId, actor.userId, 'logout');
    return ok({ id: actor.sessionId });
  }

  /**
   * Own list, or any user's with `auth.session.read`. Without the permission a
   * foreign `userId` is answered exactly like a miss — 404, never 403
   * (error-catalog §2: a 403 confirms existence).
   */
  async list(
    actor: SessionActor,
    target: { userId?: string; page: number; pageSize: number },
  ): Promise<Result<SessionPage>> {
    const userId = target.userId ?? actor.userId;
    if (userId !== actor.userId && !(await actor.canActOnOthers())) {
      return fail(sharedErrors.notFound());
    }

    const { rows, total } = await this.sessions.listForUser(userId, target.page, target.pageSize);
    return ok({
      rows: rows.map((row) => ({ ...row, current: row.id === actor.sessionId })),
      total,
    });
  }

  /**
   * Revoking the acting session behaves as logout; revoking an already-revoked
   * session is a success no-op (UC-AUTH-004).
   */
  async revoke(actor: SessionActor, sessionId: string): Promise<Result<{ id: string }>> {
    const session = await this.sessions.findById(sessionId);
    if (!session) return fail(sharedErrors.notFound());
    if (session.userId !== actor.userId && !(await actor.canActOnOthers())) {
      return fail(sharedErrors.notFound());
    }

    const reason: SessionRevokedReason =
      sessionId === actor.sessionId ? 'logout' : session.userId === actor.userId ? 'user' : 'admin';
    await this.revokeWithEvent(actor.tenantId, sessionId, session.userId, reason);
    return ok({ id: sessionId });
  }

  /** Always scoped to the acting user — the permission never widens this one. */
  async revokeOthers(actor: SessionActor): Promise<Result<{ revokedCount: number }>> {
    const revokedIds = await this.sessions.revokeAllForUser(
      actor.userId,
      'user',
      this.clock.now(),
      actor.sessionId,
    );
    for (const id of revokedIds) {
      await this.emitRevoked(actor.tenantId, id, actor.userId, 'user');
    }
    return ok({ revokedCount: revokedIds.length });
  }

  private async revokeWithEvent(
    tenantId: string,
    sessionId: string,
    userId: string,
    reason: SessionRevokedReason,
  ): Promise<void> {
    const revoked = await this.sessions.revoke(sessionId, reason, this.clock.now());
    if (revoked) await this.emitRevoked(tenantId, sessionId, userId, reason);
  }

  private async emitRevoked(
    tenantId: string,
    sessionId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    await this.outbox.emit({
      name: 'auth.session.revoked',
      tenantId,
      aggregateId: sessionId,
      payload: { sessionId, userId, reason },
    });
  }
}
