import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { authErrors } from '../domain/auth.errors';
import {
  AUTH_LOOKUP_REPOSITORY,
  AUTH_OUTBOX,
  DEVICE_REPOSITORY,
  SESSION_REPOSITORY,
  USER_ACCOUNT_REPOSITORY,
  type AuthLookupRepositoryPort,
  type AuthOutboxPort,
  type DeviceRepositoryPort,
  type SessionRecord,
  type SessionRepositoryPort,
  type UserAccountRepositoryPort,
} from '../domain/auth.ports';
import { AUTH_DEFAULTS } from './auth-defaults';
import { hashToken, mintRefreshToken } from './refresh-token';
import {
  ACCESS_TOKEN_SERVICE,
  ROTATION_GRACE_CACHE,
  TENANT_STATUS_PORT,
  TENANT_TRANSACTION,
  USED_TOKEN_HISTORY,
  type AccessTokenPort,
  type RefreshSuccessor,
  type RotationGracePort,
  type TenantStatusPort,
  type TenantTransactionPort,
  type UsedTokenHistoryPort,
} from './ports/auth-services.port';

export interface RefreshCommand {
  refreshToken: string;
  /** Mobile only: rides when FCM rotated the token since the last report (§7). */
  fcmToken?: string;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * UC-AUTH-002 — rotate a refresh token.
 *
 * The decision ladder is ordered by what each step can know: the grace cache
 * needs only the hash; the session row supplies the liveness inputs; tenant and
 * user status need the row; the device check and the rotation write need a
 * tenant context. Nothing is written until everything has passed.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(AUTH_LOOKUP_REPOSITORY) private readonly lookup: AuthLookupRepositoryPort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepositoryPort,
    @Inject(USER_ACCOUNT_REPOSITORY) private readonly users: UserAccountRepositoryPort,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly tokens: AccessTokenPort,
    @Inject(TENANT_STATUS_PORT) private readonly tenants: TenantStatusPort,
    @Inject(TENANT_TRANSACTION) private readonly tx: TenantTransactionPort,
    @Inject(ROTATION_GRACE_CACHE) private readonly grace: RotationGracePort,
    @Inject(USED_TOKEN_HISTORY) private readonly history: UsedTokenHistoryPort,
    @Inject(AUTH_OUTBOX) private readonly outbox: AuthOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(cmd: RefreshCommand): Promise<Result<RefreshSuccessor>> {
    const presentedHash = hashToken(cmd.refreshToken);

    // BR-AUTH-005: a just-rotated token replayed within the window gets the
    // *same* successor pair. Multi-tab web races are not theft.
    const cached = await this.grace.lookup(presentedHash);
    if (cached) return ok(cached);

    const session = await this.lookup.findSessionByRefreshHash(presentedHash);
    if (!session) return this.handleUnknownHash(presentedHash);

    const now = this.clock.now();

    if (session.revokedAt) {
      // The *current* hash of a revoked session is not a replay — BR-AUTH-004's
      // family revoke is for rotated-away hashes. A device-revoked session must
      // answer with the terminal code so the client enters the revoked-device
      // flow rather than a re-login loop (BR-AUTH-014, offline-sync §9).
      return session.revokedReason === 'device_revoked'
        ? fail(authErrors.deviceRevoked())
        : fail(authErrors.refreshInvalid());
    }

    // BR-AUTH-006: absolute cap, then the sliding window.
    if (session.expiresAt.getTime() <= now.getTime()) return fail(authErrors.refreshInvalid());
    const slidingDays = session.deviceId
      ? AUTH_DEFAULTS.refreshSlidingDaysMobile
      : AUTH_DEFAULTS.refreshSlidingDaysWeb;
    if (session.lastUsedAt.getTime() + slidingDays * DAY_MS <= now.getTime()) {
      return fail(authErrors.refreshInvalid());
    }

    // BR-AUTH-011: a suspended tenant blocks refresh. A *missing* tenant is a
    // stale token — re-login is the client's correct move, not "contact support".
    const tenantStatus = await this.tenants.status(session.tenantId);
    if (tenantStatus === 'missing') return fail(authErrors.refreshInvalid());
    if (tenantStatus !== 'active') return fail(authErrors.tenantSuspended());

    const rotated = await this.tx.runInTenant(session.tenantId, async () => {
      // §9: refresh rejects on user status. One code — an attacker holding a
      // stolen refresh token learns nothing about *why* it stopped working.
      const user = await this.users.findById(session.userId);
      if (!user || user.status !== 'active') return null;

      if (session.deviceId) {
        const device = await this.devices.findById(session.deviceId);
        // BR-AUTH-014: a revoked device turns its sessions dead at the next
        // API contact. Revoke here rather than waiting for the purge job so
        // the session list stops showing it as live.
        if (!device || device.status === 'revoked') {
          const revoked = await this.sessions.revoke(session.id, 'device_revoked', now);
          if (revoked) await this.emitSessionRevoked(session, 'device_revoked');
          return 'device_revoked' as const;
        }

        if (cmd.fcmToken && cmd.fcmToken !== device.fcmToken) {
          await this.devices.updateFcmToken(session.deviceId, cmd.fcmToken, now);
        }
      }

      const minted = mintRefreshToken();
      await this.sessions.rotate(session.id, minted.hash, now);
      return minted;
    });
    if (rotated === null) return fail(authErrors.refreshInvalid());
    if (rotated === 'device_revoked') return fail(authErrors.deviceRevoked());

    const { token: accessToken, expiresInSeconds } = await this.tokens.sign({
      sub: session.userId,
      tenantId: session.tenantId,
      sid: session.id,
      typ: 'access',
    });

    const successor: RefreshSuccessor = {
      accessToken,
      expiresInSeconds,
      refreshToken: rotated.token,
      web: session.deviceId === null,
      persistCookie: session.trustedDevice,
    };

    // Both after the commit: a rolled-back rotation must leave no history entry
    // to family-revoke on, and no grace entry replaying a pair that never was.
    await this.history.remember(presentedHash, {
      sessionId: session.id,
      tenantId: session.tenantId,
    });
    await this.grace.remember(presentedHash, successor);

    return ok(successor);
  }

  /**
   * BR-AUTH-004: a hash that is in the used history but no longer in `sessions`
   * is a replay past the grace window — revoke the whole session family.
   *
   * A hash in neither store is plain garbage. That includes the race where a
   * concurrent rotation committed but has not written history yet: failing that
   * sliver as `AUTH_REFRESH_INVALID` is safe (no false family kill), and the
   * client's retry lands in the grace cache.
   */
  private async handleUnknownHash(presentedHash: string): Promise<Result<RefreshSuccessor>> {
    const used = await this.history.lookup(presentedHash);
    if (!used) return fail(authErrors.refreshInvalid());

    const now = this.clock.now();
    await this.tx.runInTenant(used.tenantId, async () => {
      const revoked = await this.sessions.revoke(used.sessionId, 'token_reuse', now);
      if (revoked) {
        const session = await this.sessions.findById(used.sessionId);
        if (session) await this.emitSessionRevoked(session, 'token_reuse');
      }
    });

    return fail(authErrors.refreshReused());
  }

  private async emitSessionRevoked(session: SessionRecord, reason: string): Promise<void> {
    await this.outbox.emit({
      name: 'auth.session.revoked',
      tenantId: session.tenantId,
      aggregateId: session.id,
      payload: { sessionId: session.id, userId: session.userId, reason },
    });
  }
}
