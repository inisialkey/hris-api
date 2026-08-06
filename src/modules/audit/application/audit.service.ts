import { Inject, Injectable } from '@nestjs/common';

import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import {
  AUDIT_REPOSITORY,
  type AuditActorType,
  type AuditPort,
  type AuditRepositoryPort,
} from '../domain/audit.ports';

/**
 * UC-AUD-003 — the sensitive-read channel, and the only write path that exists
 * before the repository hook and the event relay do.
 *
 * Two properties are the whole use case:
 *
 * **Same request, no queue.** A read audit that can be lost is not an access
 * record, so this never goes near BullMQ. It costs nothing in practice — the
 * insert joins the transaction the read is already holding.
 *
 * **Fail-closed.** Nothing is caught here. The insert runs inside the request's
 * unit-of-work, so a failure rolls the transaction back and the caller's read is
 * refused with `SYS_INTERNAL` (grilled 2026-08-02). Wrapping this in a
 * `try/catch` would convert the module's central promise — that a sensitive read
 * always leaves a trace — into a best effort, silently.
 */
@Injectable()
export class AuditService implements AuditPort {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  async sensitiveRead(
    actionKey: string,
    entityType: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const tenant = requireTenantContext();
    const request = currentRequestContext();

    await this.repository.append({
      tenantId: tenant.tenantId,
      actorType: actorType(request?.userId),
      actorUserId: request?.userId,
      // BR-AUD-008: both identities, neither inferred. An impersonated read
      // files under the impersonated user with the operator named beside them —
      // the platform-console acts that carry `platform_op` and a NULL actor are
      // a different channel (system-administration BR-ADM-023).
      impersonatorId: tenant.impersonatorId,
      requestId: request?.requestId,
      action: actionKey,
      entityType,
      entityId,
      metadata,
    });
  }
}

/** No user in scope means a job or a relay did the reading (BR-AUD-008). */
function actorType(userId: string | undefined): AuditActorType {
  return userId ? 'user' : 'system';
}
