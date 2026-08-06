import { Inject, Injectable } from '@nestjs/common';

import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { USER_ACCOUNT_REPOSITORY, type UserAccountRepositoryPort } from '../domain/auth.ports';
import { LOGIN_ATTEMPT_SERVICE, type LoginAttemptPort } from './ports/auth-services.port';

/**
 * `auth.user.unlock` (BR-AUTH-013): clears the persistent administrative lock
 * *and* the timed Redis counter — an unlock that leaves the 15-minute window
 * running would look broken to the administrator who just clicked it. Runs in
 * the request's tenant transaction; a miss hides as 404.
 */
@Injectable()
export class AccountAdminUseCase {
  constructor(
    @Inject(USER_ACCOUNT_REPOSITORY) private readonly users: UserAccountRepositoryPort,
    @Inject(LOGIN_ATTEMPT_SERVICE) private readonly attempts: LoginAttemptPort,
  ) {}

  async unlock(actorId: string, userId: string): Promise<Result<{ id: string }>> {
    const user = await this.users.findById(userId);
    if (!user) return fail(sharedErrors.notFound());

    // Unlocking an unlocked account is a success no-op, same shape as the
    // session no-ops — the administrator's goal state already holds.
    if (user.status === 'locked') await this.users.unlock(userId, actorId);
    await this.attempts.recordSuccess(user.email);

    return ok({ id: userId });
  }
}
