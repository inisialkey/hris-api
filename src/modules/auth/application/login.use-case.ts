import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { authErrors } from '../domain/auth.errors';
import {
  AUTH_LOOKUP_REPOSITORY,
  AUTH_OUTBOX,
  DEVICE_REPOSITORY,
  SESSION_REPOSITORY,
  type AuthLookupRepositoryPort,
  type AuthOutboxPort,
  type CandidateUser,
  type DeviceRepositoryPort,
  type SessionRepositoryPort,
} from '../domain/auth.ports';
import { AUTH_DEFAULTS } from './auth-defaults';
import { mintRefreshToken } from './refresh-token';
import {
  ACCESS_TOKEN_SERVICE,
  LOGIN_ATTEMPT_SERVICE,
  PASSWORD_SERVICE,
  TENANT_TRANSACTION,
  type AccessTokenPort,
  type LoginAttemptPort,
  type PasswordPort,
  type TenantTransactionPort,
} from './ports/auth-services.port';

export interface LoginDeviceInfo {
  installId: string;
  platform: 'android' | 'ios';
  model: string;
  osVersion: string;
  appVersion: string;
  fcmToken?: string;
}

export interface LoginCommand {
  email: string;
  password: string;
  /** Second call, after the picker. */
  tenantId?: string;
  rememberDevice: boolean;
  ip: string;
  userAgent?: string;
  /** Present = mobile login (§7: required for mobile, absent on web). */
  device?: LoginDeviceInfo;
  /** Self-service replacement under BR-AUTH-007. */
  replaceDeviceId?: string;
}

export interface TenantChoice {
  tenantId: string;
  tenantName: string;
}

export type LoginResult =
  | {
      kind: 'session';
      accessToken: string;
      expiresInSeconds: number;
      refreshToken: string;
      /** Web sessions receive the refresh token as a cookie, mobile in the body (§7). */
      web: boolean;
      user: { id: string; email: string };
      tenant: { id: string; name: string };
    }
  | { kind: 'picker'; tenantChoices: TenantChoice[] };

/**
 * UC-AUTH-001.
 *
 * The order of the first two steps is load-bearing: the lockout check runs
 * before any password verification, so an attacker inside a lockout window pays
 * nothing and learns nothing, and the rate-limit guard has already run before
 * this use case was reached at all.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(AUTH_LOOKUP_REPOSITORY) private readonly lookup: AuthLookupRepositoryPort,
    @Inject(PASSWORD_SERVICE) private readonly passwords: PasswordPort,
    @Inject(LOGIN_ATTEMPT_SERVICE) private readonly attempts: LoginAttemptPort,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly tokens: AccessTokenPort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepositoryPort,
    @Inject(AUTH_OUTBOX) private readonly outbox: AuthOutboxPort,
    @Inject(TENANT_TRANSACTION) private readonly tx: TenantTransactionPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(cmd: LoginCommand): Promise<Result<LoginResult>> {
    const email = cmd.email.trim().toLowerCase();

    const retryAfterSeconds = await this.attempts.check(email);
    if (retryAfterSeconds !== null) {
      return fail(authErrors.accountLocked({ retryAfterSeconds }));
    }

    const candidates = await this.lookup.findCandidatesByEmail(email);

    if (candidates.length === 0) {
      // Burn the same CPU a real verify would have. BR-AUTH-002 wants one code
      // *and* one timing profile; the code alone is half a defence.
      await this.passwords.verifyDummy(cmd.password);
      await this.attempts.recordFailure(email);
      return fail(authErrors.invalidCredentials());
    }

    const verified: CandidateUser[] = [];
    for (const candidate of candidates) {
      // Sequential rather than `Promise.all`: argon2 at 64 MiB × 4 lanes is not
      // something to run N-wide on one request, and N is attacker-influenced.
      const matches = await this.passwords.verify(candidate.passwordHash, cmd.password);
      if (matches) verified.push(candidate);
    }

    if (verified.length === 0) {
      await this.attempts.recordFailure(email);
      return fail(authErrors.invalidCredentials());
    }

    // `locked` is the persistent administrative lock, distinct from the timed
    // one above and cleared only via `auth.user.unlock` (BR-AUTH-013).
    if (verified.some((u) => u.status === 'locked')) {
      return fail(authErrors.accountLocked());
    }

    // An `inactive` user is indistinguishable from a wrong password (BR-AUTH-002).
    const active = verified.filter((u) => u.status === 'active');
    if (active.length === 0) {
      await this.attempts.recordFailure(email);
      return fail(authErrors.invalidCredentials());
    }

    const tenants = await this.lookup.findTenants(active.map((u) => u.tenantId));
    const byId = new Map(tenants.map((t) => [t.id, t]));

    // Suspended and archived tenants are silently absent from the choices
    // (BR-AUTH-001) — listing them would answer "does this company use the
    // product" for anyone holding one valid credential.
    //
    // Carried as pairs rather than filtered ids so the tenant name is present by
    // construction: a lookup that "cannot miss" needs no assertion to say so.
    const selectable = active.flatMap((user) => {
      const tenant = byId.get(user.tenantId);
      return tenant && tenant.status === 'active' ? [{ user, tenant }] : [];
    });

    if (cmd.tenantId !== undefined) {
      const chosen = selectable.find((c) => c.user.tenantId === cmd.tenantId);
      if (!chosen) {
        // Either the tenant is suspended, or the credential does not hold there.
        const exists = active.some((u) => u.tenantId === cmd.tenantId);
        return fail(exists ? authErrors.tenantSuspended() : authErrors.invalidCredentials());
      }
      return this.issue(chosen.user, chosen.tenant.name, cmd, email);
    }

    const [sole] = selectable;
    if (!sole) {
      // Every match is suspended. The sole-match case of BR-AUTH-001.
      return fail(authErrors.tenantSuspended());
    }

    if (selectable.length > 1) {
      await this.attempts.recordSuccess(email);
      return ok({
        kind: 'picker',
        tenantChoices: selectable.map((c) => ({
          tenantId: c.user.tenantId,
          tenantName: c.tenant.name,
        })),
      });
    }

    return this.issue(sole.user, sole.tenant.name, cmd, email);
  }

  private async issue(
    user: CandidateUser,
    tenantName: string,
    cmd: LoginCommand,
    email: string,
  ): Promise<Result<LoginResult>> {
    const { token: refreshToken, hash: refreshTokenHash } = mintRefreshToken();

    const sessionId = await this.tx.runInTenant(user.tenantId, async () => {
      const deviceId = cmd.device ? await this.resolveDevice(user, cmd.device, cmd) : undefined;
      if (typeof deviceId === 'object') return deviceId; // a Result — the refusal

      const id = await this.sessions.create({
        tenantId: user.tenantId,
        userId: user.id,
        deviceId,
        refreshTokenHash,
        trustedDevice: cmd.rememberDevice,
        ip: cmd.ip,
        userAgent: cmd.userAgent,
        expiresAt: this.absoluteExpiry(cmd.rememberDevice, cmd.device !== undefined),
      });
      await this.sessions.stampLastLogin(user.id);
      return id;
    });
    if (typeof sessionId !== 'string') return sessionId;

    const { token, expiresInSeconds } = await this.tokens.sign({
      sub: user.id,
      tenantId: user.tenantId,
      sid: sessionId,
      typ: 'access',
    });

    await this.attempts.recordSuccess(email);

    return ok({
      kind: 'session',
      accessToken: token,
      expiresInSeconds,
      refreshToken,
      web: cmd.device === undefined,
      user: { id: user.id, email: user.email },
      tenant: { id: user.tenantId, name: tenantName },
    });
  }

  /**
   * BR-AUTH-007/BR-AUTH-014, inside the login transaction: resolve the install
   * to a device row id, or return the refusal.
   *
   * A known active install is touched and reused. A revoked install is refused
   * terminally — revocation is per install and per tenant, and it does not wash
   * off with a re-login. A new install must fit under the device limit, or ride
   * a valid self-service replacement, in which case old device and old sessions
   * fall in this same transaction (the "atomically" of BR-AUTH-007).
   */
  private async resolveDevice(
    user: CandidateUser,
    device: LoginDeviceInfo,
    cmd: LoginCommand,
  ): Promise<string | Result<LoginResult>> {
    const now = this.clock.now();
    const existing = await this.devices.findByInstallId(device.installId);

    if (existing) {
      if (existing.status === 'revoked') return fail(authErrors.deviceRevoked());
      await this.devices.touch(
        existing.id,
        {
          model: device.model,
          osVersion: device.osVersion,
          appVersion: device.appVersion,
          fcmToken: device.fcmToken,
        },
        now,
      );
      return existing.id;
    }

    const activeCount = await this.devices.countActiveForUser(user.id);
    if (activeCount >= AUTH_DEFAULTS.maxActiveDevices) {
      const policy = AUTH_DEFAULTS.deviceReplacementPolicy;
      if (policy !== 'self_service' || !cmd.replaceDeviceId) {
        // Under the `admin` policy the System Administrator is also notified of
        // the blocked attempt (§13) — that consumer arrives with the
        // notification module, a named omission until then.
        return fail(
          authErrors.deviceLimitReached({ maxDevices: AUTH_DEFAULTS.maxActiveDevices, policy }),
        );
      }

      const old = await this.devices.findById(cmd.replaceDeviceId);
      // Only the user's own active device is replaceable; anything else is a
      // plain miss (error-catalog §2 existence hiding).
      if (!old || old.userId !== user.id || old.status !== 'active') {
        return fail(sharedErrors.notFound());
      }

      await this.devices.revoke(old.id, 'replaced', now);
      const sessionIds = await this.sessions.revokeForDevice(old.id, now);
      for (const sessionId of sessionIds) {
        await this.outbox.emit({
          name: 'auth.session.revoked',
          tenantId: user.tenantId,
          aggregateId: sessionId,
          payload: { sessionId, userId: user.id, reason: 'device_revoked' },
        });
      }
      await this.outbox.emit({
        name: 'auth.device.revoked',
        tenantId: user.tenantId,
        aggregateId: old.id,
        payload: { deviceId: old.id, userId: user.id },
      });
    }

    return this.devices.create(
      {
        tenantId: user.tenantId,
        userId: user.id,
        installId: device.installId,
        platform: device.platform,
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        fcmToken: device.fcmToken,
      },
      now,
    );
  }

  /**
   * ADR-0004's absolute caps: mobile 90 days; web 30 days remembered, 12 hours
   * not. The sliding halves live in the refresh path (BR-AUTH-006).
   */
  private absoluteExpiry(rememberDevice: boolean, mobile: boolean): Date {
    const hours = mobile
      ? AUTH_DEFAULTS.refreshAbsoluteDaysMobile * 24
      : rememberDevice
        ? AUTH_DEFAULTS.refreshAbsoluteDaysWeb * 24
        : AUTH_DEFAULTS.refreshUnrememberedHoursWeb;
    return new Date(this.clock.now().getTime() + hours * 3600 * 1000);
  }
}
