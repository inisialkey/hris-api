import { Module } from '@nestjs/common';

import { registerErrorStatuses } from '../../shared/error-status.registry';
import { PermissionResolverService } from './application/permission-resolver.service';
import {
  ASSIGNMENT_QUERY,
  PERMISSION_CACHE,
  TENANT_TRANSACTION_AUTHZ,
} from './application/ports/authz.ports';
import { authzErrorStatus } from './domain/authz.errors';
import { ROLE_HOLDER_PORT } from './domain/role-holder.port';
import {
  AssignmentRepository,
  AuthzTransactionAdapter,
  PermissionCacheRedis,
} from './infrastructure/assignment.repository';
import { RoleRepository } from './infrastructure/role.repository';
import { PermissionGuard } from './presentation/permission.guard';

registerErrorStatuses(authzErrorStatus);

@Module({
  providers: [
    PermissionResolverService,
    { provide: ASSIGNMENT_QUERY, useClass: AssignmentRepository },
    { provide: PERMISSION_CACHE, useClass: PermissionCacheRedis },
    { provide: TENANT_TRANSACTION_AUTHZ, useClass: AuthzTransactionAdapter },
    { provide: ROLE_HOLDER_PORT, useClass: RoleRepository },
    PermissionGuard,
  ],
  exports: [PermissionResolverService, PermissionGuard, ROLE_HOLDER_PORT],
})
export class AuthzModule {}
