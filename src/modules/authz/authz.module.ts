import { Module } from '@nestjs/common';

import { registerErrorStatuses } from '../../shared/error-status.registry';
import { PermissionResolverService } from './application/permission-resolver.service';
import {
  ASSIGNMENT_QUERY,
  PERMISSION_CACHE,
  TENANT_TRANSACTION_AUTHZ,
} from './application/ports/authz.ports';
import { authzErrorStatus } from './domain/authz.errors';
import {
  AssignmentRepository,
  AuthzTransactionAdapter,
  PermissionCacheRedis,
} from './infrastructure/assignment.repository';
import { PermissionGuard } from './presentation/permission.guard';

registerErrorStatuses(authzErrorStatus);

@Module({
  providers: [
    PermissionResolverService,
    { provide: ASSIGNMENT_QUERY, useClass: AssignmentRepository },
    { provide: PERMISSION_CACHE, useClass: PermissionCacheRedis },
    { provide: TENANT_TRANSACTION_AUTHZ, useClass: AuthzTransactionAdapter },
    PermissionGuard,
  ],
  exports: [PermissionResolverService, PermissionGuard],
})
export class AuthzModule {}
