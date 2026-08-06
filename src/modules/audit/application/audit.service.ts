import { Inject, Injectable } from '@nestjs/common';

import { getTableName } from 'drizzle-orm';

import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import {
  AUDIT_REPOSITORY,
  type AuditActorType,
  type AuditChange,
  type AuditChangePort,
  type AuditPort,
  type AuditRepositoryPort,
} from '../domain/audit.ports';
import { buildChangeDiff } from '../domain/audited-tables';

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
export class AuditService implements AuditPort, AuditChangePort {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort) {}

  /**
   * UC-AUD-001 — channel 1. Same properties as the read channel and for the same
   * reason: the insert joins the mutating transaction, so it commits with the
   * change or not at all (BR-AUD-002). Nothing is caught.
   *
   * Masking is applied here rather than in the repository base, because
   * BR-AUD-005 and the §4.2 registry are this module's and a caller that could
   * choose what to mask would be a caller that could choose not to.
   */
  async recordChange(change: AuditChange): Promise<void> {
    const tenant = requireTenantContext();
    const request = currentRequestContext();
    const entityType = getTableName(change.table);
    const diff = buildChangeDiff(change.table, change.action, change.before, change.after);

    // An update whose changed-column set is empty changed nothing anyone can
    // read back. Filing it would add a row per no-op save to the trail this log
    // exists to make legible.
    if (change.action === 'updated' && Object.keys(diff.changed).length === 0) return;

    await this.repository.append({
      tenantId: tenant.tenantId,
      actorType: actorType(request?.userId),
      actorUserId: request?.userId,
      impersonatorId: tenant.impersonatorId,
      requestId: request?.requestId,
      action: `${entityType}.${change.action}`,
      entityType,
      entityId: change.entityId,
      diff,
    });
  }

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
