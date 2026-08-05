import { Module } from '@nestjs/common';

import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuthzModule } from '../authz';
import { LoginUseCase } from './application/login.use-case';
import {
  ACCESS_TOKEN_SERVICE,
  IDENTITY_QUERY,
  LOGIN_ATTEMPT_SERVICE,
  PASSWORD_SERVICE,
  TENANT_STATUS_PORT,
  TENANT_TRANSACTION,
} from './application/ports/auth-services.port';
import { authErrorStatus } from './domain/auth.errors';
import { AUTH_LOOKUP_REPOSITORY, SESSION_REPOSITORY } from './domain/auth.ports';
import { AccessTokenService } from './infrastructure/access-token.service';
import { AuthLookupRepository } from './infrastructure/auth-lookup.repository';
import { IdentityRepository } from './infrastructure/identity.repository';
import { LoginAttemptService } from './infrastructure/login-attempt.service';
import { PasswordService } from './infrastructure/password.service';
import { SessionRepository } from './infrastructure/session.repository';
import {
  TenantStatusAdapter,
  TenantTransactionAdapter,
} from './infrastructure/tenant-transaction.adapter';
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
    { provide: AUTH_LOOKUP_REPOSITORY, useClass: AuthLookupRepository },
    { provide: SESSION_REPOSITORY, useClass: SessionRepository },
    { provide: PASSWORD_SERVICE, useClass: PasswordService },
    { provide: LOGIN_ATTEMPT_SERVICE, useClass: LoginAttemptService },
    { provide: ACCESS_TOKEN_SERVICE, useClass: AccessTokenService },
    { provide: IDENTITY_QUERY, useClass: IdentityRepository },
    { provide: TENANT_TRANSACTION, useClass: TenantTransactionAdapter },
    { provide: TENANT_STATUS_PORT, useClass: TenantStatusAdapter },
    JwtAuthGuard,
    TenantStatusGuard,
  ],
  exports: [ACCESS_TOKEN_SERVICE, JwtAuthGuard, TenantStatusGuard],
})
export class AuthModule {}
