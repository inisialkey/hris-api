import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { currentTenantContext } from '../../../shared/context';
import { AppErrorException } from '../../../shared/unwrap';
import { IS_PUBLIC } from '../../authz';
import { TENANT_STATUS_PORT, type TenantStatusPort } from '../application/ports/auth-services.port';
import { authErrors } from '../domain/auth.errors';

/**
 * Chain position 4 (backend-nestjs §5). `suspended` and `archived` both block
 * every authenticated route, including refresh (BR-AUTH-011); in-flight access
 * tokens die at their 15-minute horizon rather than being hunted down.
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TENANT_STATUS_PORT) private readonly tenants: TenantStatusPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const tenant = currentTenantContext();
    if (!tenant) throw new AppErrorException(authErrors.tokenInvalid());

    const status = await this.tenants.status(tenant.tenantId);
    // A valid signature naming a dead tenant is a stale or forged token, and
    // multi-tenancy §2 maps it to `AUTH_TOKEN_INVALID` rather than to a
    // suspension — the client's correct move is re-login, not "contact support".
    if (status === 'missing') throw new AppErrorException(authErrors.tokenInvalid());
    if (status !== 'active') throw new AppErrorException(authErrors.tenantSuspended());

    return true;
  }
}
