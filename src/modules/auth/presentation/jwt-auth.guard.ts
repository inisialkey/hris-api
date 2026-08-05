import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC } from '../../authz';
import {
  requireRequestContext,
  setRequestContext,
  setTenantContext,
} from '../../../shared/context';
import { AppErrorException } from '../../../shared/unwrap';
import {
  ACCESS_TOKEN_SERVICE,
  type AccessTokenPort,
} from '../application/ports/auth-services.port';
import { authErrors } from '../domain/auth.errors';

/**
 * Chain position 3 (backend-nestjs §5): verify the access token and populate
 * both contexts.
 *
 * Tenant resolution is the `tenantId` **claim**, never a header, a query
 * parameter, or a subdomain (multi-tenancy §2). A tenant a client can name is a
 * tenant a client can choose.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_SERVICE) private readonly tokens: AccessTokenPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new AppErrorException(authErrors.tokenInvalid());

    const claims = await this.tokens.verify(header.slice('Bearer '.length));
    // One code for a malformed token, a bad signature, an unknown `kid`, and a
    // token whose `typ` is not `access`. Distinguishing them tells an attacker
    // which half of the forgery worked.
    if (!claims) throw new AppErrorException(authErrors.tokenInvalid());

    setTenantContext({ tenantId: claims.tenantId, source: 'jwt' });
    setRequestContext({ ...requireRequestContext(), userId: claims.sub, sessionId: claims.sid });

    return true;
  }
}
