import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { FIELD_ENTRIES } from '../../../shared/validation-details';
import { authErrors } from '../domain/auth.errors';
import {
  AUTH_LOOKUP_REPOSITORY,
  AUTH_OUTBOX,
  AUTH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
  USER_ACCOUNT_REPOSITORY,
  type AuthLookupRepositoryPort,
  type AuthOutboxPort,
  type AuthTokenRepositoryPort,
  type SessionRepositoryPort,
  type SessionRevokedReason,
  type UserAccountRepositoryPort,
} from '../domain/auth.ports';
import { checkPasswordPolicy } from '../domain/password-policy';
import { RESET_TOKEN_TTL_MINUTES } from './auth-defaults';
import { hashToken, mintRefreshToken } from './refresh-token';
import {
  LOGIN_ATTEMPT_SERVICE,
  PASSWORD_SERVICE,
  TENANT_TRANSACTION,
  type LoginAttemptPort,
  type PasswordPort,
  type TenantTransactionPort,
} from './ports/auth-services.port';

/**
 * UC-AUTH-006/007/008 — every flow that sets a credential.
 *
 * Email delivery is a named omission: the token rows are created and the
 * notification module (spine order 6) will carry the links. The raw token never
 * enters the outbox — payloads are pointers and primitives (§12), and `token`
 * is on the redaction registry; delivery will take the raw value in-process
 * when its consumer exists.
 */
@Injectable()
export class PasswordUseCase {
  constructor(
    @Inject(AUTH_LOOKUP_REPOSITORY) private readonly lookup: AuthLookupRepositoryPort,
    @Inject(AUTH_TOKEN_REPOSITORY) private readonly tokens: AuthTokenRepositoryPort,
    @Inject(USER_ACCOUNT_REPOSITORY) private readonly users: UserAccountRepositoryPort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_SERVICE) private readonly passwords: PasswordPort,
    @Inject(LOGIN_ATTEMPT_SERVICE) private readonly attempts: LoginAttemptPort,
    @Inject(TENANT_TRANSACTION) private readonly tx: TenantTransactionPort,
    @Inject(AUTH_OUTBOX) private readonly outbox: AuthOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * UC-AUTH-006 request half. Fired-and-forgotten by the controller — the 200
   * has already left, which is what makes the timing identical whether the
   * email exists or not (BR-AUTH-010). Multi-tenant emails get one token per
   * membership, each its own row.
   */
  async requestReset(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const candidates = await this.lookup.findCandidatesByEmail(normalized);
    const now = this.clock.now().getTime();

    for (const candidate of candidates) {
      if (candidate.status === 'inactive') continue;
      const minted = mintRefreshToken();
      await this.tx.runInTenant(candidate.tenantId, () =>
        this.tokens.create({
          tenantId: candidate.tenantId,
          userId: candidate.id,
          tokenHash: minted.hash,
          purpose: 'password_reset',
          expiresAt: new Date(now + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
        }),
      );
      // Delivery: notification module, when it exists. The raw `minted.token`
      // dies with this scope until then.
    }
  }

  /**
   * The admin trigger (`auth.user.reset`) — same row, `created_by` stamped.
   * Runs inside the request's tenant transaction; a miss hides as 404.
   */
  async requestResetForUser(
    actor: { userId: string; tenantId: string },
    userId: string,
  ): Promise<Result<{ id: string }>> {
    const user = await this.users.findById(userId);
    if (!user) return fail(sharedErrors.notFound());
    const minted = mintRefreshToken();
    await this.tokens.create({
      tenantId: actor.tenantId,
      userId,
      tokenHash: minted.hash,
      purpose: 'password_reset',
      expiresAt: new Date(this.clock.now().getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
      createdBy: actor.userId,
    });
    return ok({ id: userId });
  }

  /** UC-AUTH-006 confirm half: single-use, TTL, policy, revoke **all**. */
  async confirmReset(token: string, newPassword: string): Promise<Result<Record<never, never>>> {
    return this.consumeTokenAndSetPassword({
      token,
      newPassword,
      purpose: 'password_reset',
      invalid: authErrors.resetTokenInvalid,
      revokeReason: 'password_reset',
      via: 'reset',
    });
  }

  /** UC-AUTH-008: same single-use mechanics, its own code, no auto-login. */
  async acceptInvite(token: string, password: string): Promise<Result<Record<never, never>>> {
    return this.consumeTokenAndSetPassword({
      token,
      newPassword: password,
      purpose: 'invite',
      invalid: authErrors.inviteTokenInvalid,
      revokeReason: 'password_reset',
      via: null,
    });
  }

  /**
   * UC-AUTH-007. Runs inside the request's tenant transaction. The current-
   * password check deliberately feeds no lockout counter (§5) — the caller is
   * already authenticated, and locking an account from inside it hands anyone
   * at an unlocked screen a denial-of-service button.
   */
  async change(
    actor: { userId: string; sessionId: string; tenantId: string },
    currentPassword: string,
    newPassword: string,
  ): Promise<Result<Record<never, never>>> {
    const user = await this.users.findById(actor.userId);
    if (!user) return fail(authErrors.invalidCredentials());

    const matches = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!matches) return fail(authErrors.invalidCredentials());

    const entries = checkPasswordPolicy(newPassword, { email: user.email });
    if (entries.length > 0) {
      return fail(authErrors.passwordPolicyViolation({ [FIELD_ENTRIES]: entries }));
    }

    await this.users.setPasswordHash(
      actor.userId,
      await this.passwords.hash(newPassword),
      actor.userId,
    );

    // BR-AUTH-009: others die, the acting session survives.
    const revokedIds = await this.sessions.revokeAllForUser(
      actor.userId,
      'password_change',
      this.clock.now(),
      actor.sessionId,
    );
    for (const sessionId of revokedIds) {
      await this.emitSessionRevoked(actor.tenantId, sessionId, actor.userId, 'password_change');
    }
    await this.outbox.emit({
      name: 'auth.password.changed',
      tenantId: actor.tenantId,
      aggregateId: actor.userId,
      payload: { userId: actor.userId, via: 'change' },
    });

    return ok({});
  }

  private async consumeTokenAndSetPassword(input: {
    token: string;
    newPassword: string;
    purpose: 'password_reset' | 'invite';
    invalid: () => ReturnType<typeof authErrors.resetTokenInvalid>;
    revokeReason: SessionRevokedReason;
    via: 'reset' | null;
  }): Promise<Result<Record<never, never>>> {
    const row = await this.lookup.findAuthTokenByHash(hashToken(input.token));
    const now = this.clock.now();

    // One code for unknown, wrong-purpose, expired and used (BR-AUTH-010) — a
    // token prober learns nothing about which failure they achieved.
    if (
      !row ||
      row.purpose !== input.purpose ||
      row.usedAt !== null ||
      row.expiresAt.getTime() <= now.getTime()
    ) {
      return fail(input.invalid());
    }

    return this.tx.runInTenant(row.tenantId, async () => {
      const user = await this.users.findById(row.userId);
      if (!user) return fail(input.invalid());

      const entries = checkPasswordPolicy(input.newPassword, { email: user.email });
      if (entries.length > 0) {
        return fail(authErrors.passwordPolicyViolation({ [FIELD_ENTRIES]: entries }));
      }

      // The single-use gate is this UPDATE's row lock, not the read above — two
      // racing confirms cannot both pass it (§4 invariant).
      const consumed = await this.tokens.consume(row.id, now);
      if (!consumed) return fail(input.invalid());

      await this.users.setPasswordHash(
        row.userId,
        await this.passwords.hash(input.newPassword),
        row.userId,
      );

      const revokedIds = await this.sessions.revokeAllForUser(row.userId, input.revokeReason, now);
      for (const sessionId of revokedIds) {
        await this.emitSessionRevoked(row.tenantId, sessionId, row.userId, input.revokeReason);
      }

      if (input.via) {
        await this.outbox.emit({
          name: 'auth.password.changed',
          tenantId: row.tenantId,
          aggregateId: row.userId,
          payload: { userId: row.userId, via: input.via },
        });
        // "Unlock via reset" (error-catalog): a successful reset clears the
        // timed lockout so the fresh credential works immediately.
        await this.attempts.recordSuccess(user.email);
      }

      return ok({});
    });
  }

  private async emitSessionRevoked(
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
