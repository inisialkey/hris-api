import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext, requireTenantContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import {
  AUTH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
  USER_ACCOUNT_REPOSITORY,
  type AuthTokenRepositoryPort,
  type SessionRepositoryPort,
  type UserAccountRepositoryPort,
} from '../domain/auth.ports';
import { INVITE_TOKEN_TTL_DAYS } from './auth-defaults';
import { PASSWORD_SERVICE, type PasswordPort } from './ports/auth-services.port';
import { mintRefreshToken } from './refresh-token';

/**
 * `AccountLifecyclePort` (authentication.md §13) — auth's half of BR-EMP-002's
 * optional account and BR-EMP-006's exit, both inside the **caller's**
 * transaction so a hire that fails leaves no orphan login and an exit that
 * fails leaves no dead one.
 *
 * **Two deliberate splits from the §13 sentence, both ADR-0001 rather than
 * preference** (A-195):
 *
 * - *"links `employees.user_id`"* happens in the employee module, not here.
 *   `employees` is employee.md's table and rule 5 says only the owner's
 *   repositories write it. The outcome is identical and in the same
 *   transaction; the write is on the right side of the boundary.
 * - *"assigns the Employee role template"* is **not done yet**, because there is
 *   no Employee role template to assign: authorization-rbac seeds the ten
 *   templates and has not shipped, so `roles` currently holds one row per tenant.
 *   The consequence is benign and worth stating — every employee self-service
 *   route is `@AuthenticatedOnly()` (BR-AUTHZ-009), so an invited employee can
 *   use the whole employee surface with no role at all. It lands with the
 *   templates.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly log = new Logger(AccountLifecycleService.name);

  constructor(
    @Inject(USER_ACCOUNT_REPOSITORY) private readonly users: UserAccountRepositoryPort,
    @Inject(AUTH_TOKEN_REPOSITORY) private readonly tokens: AuthTokenRepositoryPort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_SERVICE) private readonly passwords: PasswordPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createUserForEmployee(
    _employeeId: string,
    email: string,
  ): Promise<Result<{ userId: string }>> {
    const normalized = email.trim().toLowerCase();
    const tenantId = requireTenantContext().tenantId;

    if (await this.users.findByEmail(normalized)) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'createAccount.email',
            code: fieldCodes.duplicate,
            messageKey: `errors.${fieldCodes.duplicate}`,
            params: { field: 'createAccount.email' },
          },
        ]),
      );
    }

    // The invitee has no password until they accept, and `password_hash` is
    // NOT NULL. Hashing random bytes costs one argon2 op per hire and yields a
    // credential nobody — including whoever reads the row — can present.
    const unusable = await this.passwords.hash(randomBytes(32).toString('base64'));
    const userId = await this.users.create({ email: normalized, passwordHash: unusable });

    const minted = mintRefreshToken();
    await this.tokens.create({
      tenantId,
      userId,
      tokenHash: minted.hash,
      purpose: 'invite',
      expiresAt: new Date(this.clock.now().getTime() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      createdBy: requireRequestContext().userId,
    });
    // Delivery is the notification module's (spine order 6). The raw token dies
    // with this scope — A-191's rule, unchanged: it never enters an outbox
    // payload, so nothing here can leak a credential into a queue.

    return ok({ userId });
  }

  /**
   * BR-EMP-006's exit. Login and refresh die immediately (BR-AUTH-002's liveness
   * predicate reads `users.status`); the access token ages out inside its
   * fifteen-minute horizon, which is the window ADR-0004 already accepts.
   */
  async deactivateUser(userId: string, reason: string): Promise<void> {
    // The reason is a domain milestone rather than a column: `revoked_reason`
    // on `sessions` carries the enum, and *why the employment ended* belongs to
    // the employee module's own trail, not to a second copy on `users`.
    this.log.log({ userId, reason }, 'deactivating user account');
    await this.users.deactivate(userId);
    // `admin` rather than a new union value: an exit is always an administrative
    // act — a termination somebody executed, or a resignation somebody approved
    // — and minting a reason for the effectuating job would describe the
    // mechanism where the enum describes the decision.
    await this.sessions.revokeAllForUser(userId, 'admin', this.clock.now());
  }
}
