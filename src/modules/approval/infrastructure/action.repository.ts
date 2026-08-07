import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalActions } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { ActionRepositoryPort } from '../domain/approval.ports';
import type { ActionRow, ActionType } from '../domain/approval.types';

/**
 * BR-APRV-015's trail. **Insert and select, and there is no third method** —
 * `UPDATE` and `DELETE` are revoked from `hris_app` in the migration, so an
 * `update` here would not be a bug caught in review, it would be a runtime
 * permission error. The revoke is what makes append-only structural rather than
 * a convention this class happens to follow (audit-log BR-AUD-001 cites this
 * table as the precedent it copied).
 */
@Injectable()
export class ActionRepository implements ActionRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async append(values: {
    instanceId: string;
    stepId?: string | null;
    actorUserId?: string | null;
    delegateOfUserId?: string | null;
    action: ActionType;
    comment?: string | null;
  }): Promise<ActionRow> {
    const inserted = await this.connection
      .handle()
      .insert(approvalActions)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        instanceId: values.instanceId,
        stepId: values.stepId ?? null,
        // NULL is the system actor (`reminded`, `escalated`) — §4's own note, and
        // the reason this column has no FK to `users`.
        actorUserId: values.actorUserId ?? null,
        delegateOfUserId: values.delegateOfUserId ?? null,
        action: values.action,
        comment: values.comment ?? null,
      })
      .returning();
    return toAction(inserted[0]!);
  }

  async listByInstance(instanceId: string): Promise<ActionRow[]> {
    const rows = await this.connection
      .handle()
      .select()
      .from(approvalActions)
      .where(eq(approvalActions.instanceId, instanceId))
      .orderBy(asc(approvalActions.createdAt), asc(approvalActions.id));
    return rows.map(toAction);
  }
}

function toAction(row: typeof approvalActions.$inferSelect): ActionRow {
  return {
    id: row.id,
    instanceId: row.instanceId,
    stepId: row.stepId,
    actorUserId: row.actorUserId,
    delegateOfUserId: row.delegateOfUserId,
    action: row.action,
    comment: row.comment,
    createdAt: row.createdAt,
  };
}
