import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  currentTenantContext,
  requireRequestContext,
  setRequestContext,
  type AuthorizationHandle,
  type ResolvedAuthorization,
} from '../../../shared/context';
import { AppErrorException } from '../../../shared/unwrap';
import { PermissionResolverService } from '../application/permission-resolver.service';
import { authzErrors } from '../domain/authz.errors';
import { IS_PUBLIC, PERMISSION_KEYS } from './authz.decorators';

/**
 * Chain position 5 (backend-nestjs §5). Two jobs:
 *
 * 1. Attach the lazy authorization handle to the request context — on **every**
 *    authenticated route, including `@AuthenticatedOnly()` ones, because their
 *    repositories still need `companyScope` (BR-AUTHZ-009).
 * 2. Check `@RequirePermission` keys when a route declares them.
 *
 * It never does data scoping. Permission gates the action, data scope gates the
 * rows, and the second lives in use cases and repositories (ADR-0005).
 *
 * A route with no marker at all does not reach here as a silent pass — it fails
 * `scripts/route-lint.ts` before merge. This guard's own default is denial.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const tenant = currentTenantContext();
    const request = requireRequestContext();
    const userId = request.userId;

    // `JwtAuthGuard` (position 3) has already rejected anything unauthenticated,
    // so reaching here without both is a wiring defect rather than a 401.
    if (!tenant || !userId) throw new Error('PermissionGuard ran before authentication');

    let resolved: Promise<ResolvedAuthorization> | undefined;
    const handle: AuthorizationHandle = {
      resolve: () => (resolved ??= this.resolver.resolve(tenant, userId)),
    };
    setRequestContext({ ...request, authorization: handle });

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEYS, targets);
    if (!required || required.length === 0) return true;

    const { permissions } = await handle.resolve();
    // Multiple keys are AND (ADR-0005). The first missing one is reported, so the
    // 403's `details.permission` names something actionable rather than a list.
    const missing = required.find((key) => !permissions.has(key));
    if (missing) throw new AppErrorException(authzErrors.permissionDenied({ permission: missing }));

    return true;
  }
}
