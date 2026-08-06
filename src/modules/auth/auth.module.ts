import { Module } from '@nestjs/common';

import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuthzModule } from '../authz';
import { AccountAdminUseCase } from './application/account-admin.use-case';
import { DeviceUseCase } from './application/device.use-case';
import { LoginUseCase } from './application/login.use-case';
import { PasswordUseCase } from './application/password.use-case';
import {
  ACCESS_TOKEN_SERVICE,
  IDENTITY_QUERY,
  LOGIN_ATTEMPT_SERVICE,
  PASSWORD_SERVICE,
  ROTATION_GRACE_CACHE,
  TENANT_STATUS_PORT,
  TENANT_TRANSACTION,
  USED_TOKEN_HISTORY,
} from './application/ports/auth-services.port';
import { RefreshUseCase } from './application/refresh.use-case';
import { SessionUseCase } from './application/session.use-case';
import { authErrorStatus } from './domain/auth.errors';
import {
  AUTH_LOOKUP_REPOSITORY,
  AUTH_OUTBOX,
  AUTH_TOKEN_REPOSITORY,
  DEVICE_REPOSITORY,
  SESSION_REPOSITORY,
  USER_ACCOUNT_REPOSITORY,
} from './domain/auth.ports';
import { AccessTokenService } from './infrastructure/access-token.service';
import { AuthLookupRepository } from './infrastructure/auth-lookup.repository';
import { AuthOutboxRepository } from './infrastructure/auth-outbox.repository';
import { AuthTokenRepository } from './infrastructure/auth-token.repository';
import { DeviceRepository } from './infrastructure/device.repository';
import { IdentityRepository } from './infrastructure/identity.repository';
import { LoginAttemptService } from './infrastructure/login-attempt.service';
import { PasswordService } from './infrastructure/password.service';
import { RotationGraceCache, UsedTokenHistory } from './infrastructure/rotation-cache.service';
import { SessionRepository } from './infrastructure/session.repository';
import {
  TenantStatusAdapter,
  TenantTransactionAdapter,
} from './infrastructure/tenant-transaction.adapter';
import { UserAccountRepository } from './infrastructure/user-account.repository';
import { AuthController } from './presentation/auth.controller';
import { JwtAuthGuard } from './presentation/jwt-auth.guard';
import { TenantStatusGuard } from './presentation/tenant-status.guard';

registerErrorStatuses(authErrorStatus);

/**
 * The runtime half of the facade (backend-nestjs §4): every token declared in
 * `domain/` or `application/ports/` is bound here to exactly one implementation
 * from `infrastructure/`. This file is the only place the two halves meet, which
 * is what keeps the layer rule enforceable by a lint rather than by memory.
 */
@Module({
  imports: [AuthzModule],
  controllers: [AuthController],
  providers: [
    LoginUseCase,
    RefreshUseCase,
    SessionUseCase,
    DeviceUseCase,
    PasswordUseCase,
    AccountAdminUseCase,
    { provide: AUTH_LOOKUP_REPOSITORY, useClass: AuthLookupRepository },
    { provide: SESSION_REPOSITORY, useClass: SessionRepository },
    { provide: DEVICE_REPOSITORY, useClass: DeviceRepository },
    { provide: AUTH_TOKEN_REPOSITORY, useClass: AuthTokenRepository },
    { provide: USER_ACCOUNT_REPOSITORY, useClass: UserAccountRepository },
    { provide: AUTH_OUTBOX, useClass: AuthOutboxRepository },
    { provide: PASSWORD_SERVICE, useClass: PasswordService },
    { provide: LOGIN_ATTEMPT_SERVICE, useClass: LoginAttemptService },
    { provide: ACCESS_TOKEN_SERVICE, useClass: AccessTokenService },
    { provide: IDENTITY_QUERY, useClass: IdentityRepository },
    { provide: TENANT_TRANSACTION, useClass: TenantTransactionAdapter },
    { provide: TENANT_STATUS_PORT, useClass: TenantStatusAdapter },
    { provide: ROTATION_GRACE_CACHE, useClass: RotationGraceCache },
    { provide: USED_TOKEN_HISTORY, useClass: UsedTokenHistory },
    JwtAuthGuard,
    TenantStatusGuard,
  ],
  exports: [ACCESS_TOKEN_SERVICE, JwtAuthGuard, TenantStatusGuard],
})
export class AuthModule {}
