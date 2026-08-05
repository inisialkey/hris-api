import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { authErrors } from '../domain/auth.errors';
import {
  AUTH_LOOKUP_REPOSITORY,
  SESSION_REPOSITORY,
  type AuthLookupRepositoryPort,
  type CandidateUser,
  type SessionRepositoryPort,
} from '../domain/auth.ports';
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

export interface LoginCommand {
  email: string;
  password: string;
  /** Second call, after the picker. */
  tenantId?: string;
  rememberDevice: boolean;
  ip: string;
  userAgent?: string;
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
    // Opaque 256-bit random, never a JWT: ADR-0004 needs revocation and a session
    // list, and a stateless refresh token cannot be killed. Only the SHA-256 goes
    // to the database — a dump of `sessions` is not a set of live credentials.
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');

    const sessionId = await this.tx.runInTenant(user.tenantId, async () => {
      const id = await this.sessions.create({
        tenantId: user.tenantId,
        userId: user.id,
        refreshTokenHash,
        trustedDevice: cmd.rememberDevice,
        ip: cmd.ip,
        userAgent: cmd.userAgent,
        expiresAt: this.absoluteExpiry(cmd.rememberDevice),
      });
      await this.sessions.stampLastLogin(user.id);
      return id;
    });

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
      user: { id: user.id, email: user.email },
      tenant: { id: user.tenantId, name: tenantName },
    });
  }

  /**
   * ADR-0004's web absolute caps: 30 days remembered, 12 hours not.
   *
   * Mobile's 90-day cap arrives with device registration, which this skeleton
   * does not issue — every session it mints is a web session with `device_id`
   * NULL (BR-AUTH-014).
   */
  private absoluteExpiry(rememberDevice: boolean): Date {
    const hours = rememberDevice ? 30 * 24 : 12;
    return new Date(this.clock.now().getTime() + hours * 3600 * 1000);
  }
}
