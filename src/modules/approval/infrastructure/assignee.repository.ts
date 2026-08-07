import { Injectable } from '@nestjs/common';
import { and, asc, eq, or, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalAssignees, approvalSteps } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { AssigneeRepositoryPort } from '../domain/approval.ports';
import type { AssigneeRow, StepStatus } from '../domain/approval.types';

/** Not audited, for `InstanceRepository`'s reason (BR-AUD-004). */
@Injectable()
export class AssigneeRepository implements AssigneeRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  async createAll(
    stepId: string,
    assignments: readonly { approverUserId: string; delegateOfUserId: string | null }[],
  ): Promise<AssigneeRow[]> {
    if (assignments.length === 0) return [];
    const tenantId = requireTenantContext().tenantId;
    const inserted = await this.db
      .insert(approvalAssignees)
      .values(assignments.map((assignment) => ({ id: uuidv7(), tenantId, stepId, ...assignment })))
      .returning();
    return inserted.map(toAssignee);
  }

  async listByStep(stepId: string): Promise<AssigneeRow[]> {
    const rows = await this.db
      .select()
      .from(approvalAssignees)
      .where(eq(approvalAssignees.stepId, stepId))
      .orderBy(asc(approvalAssignees.id));
    return rows.map(toAssignee);
  }

  async listByInstance(instanceId: string): Promise<(AssigneeRow & { stepIndex: number })[]> {
    const rows = await this.db
      .select({ assignee: approvalAssignees, stepIndex: approvalSteps.stepIndex })
      .from(approvalAssignees)
      .innerJoin(approvalSteps, eq(approvalSteps.id, approvalAssignees.stepId))
      .where(eq(approvalSteps.instanceId, instanceId))
      .orderBy(asc(approvalSteps.stepIndex), asc(approvalAssignees.id));
    return rows.map((row) => ({ ...toAssignee(row.assignee), stepIndex: row.stepIndex }));
  }

  async findSeat(stepId: string, approverUserId: string): Promise<AssigneeRow | null> {
    const rows = await this.db
      .select()
      .from(approvalAssignees)
      .where(
        and(
          eq(approvalAssignees.stepId, stepId),
          eq(approvalAssignees.approverUserId, approverUserId),
        ),
      );
    return rows[0] ? toAssignee(rows[0]) : null;
  }

  /**
   * BR-APRV-013's claim, and the reason a double-click is a 409 rather than two
   * decisions: `status = 'active'` in the predicate makes the update itself the
   * claim, so the second one matches nothing however fast it arrives.
   */
  async claim(id: string, version: number, status: StepStatus, at: Date): Promise<boolean> {
    const updated = await this.db
      .update(approvalAssignees)
      .set({ status, actedAt: at, version: version + 1 })
      .where(
        and(
          eq(approvalAssignees.id, id),
          eq(approvalAssignees.version, version),
          eq(approvalAssignees.status, 'active'),
        ),
      )
      .returning({ id: approvalAssignees.id });
    return updated.length > 0;
  }

  /**
   * The remaining seats of a decided step, closed as `skipped`. `skipped` is
   * what the inbox reads as "this item is gone and you did not act on it",
   * which is a different fact from a seat whose holder chose not to decide —
   * there is no such state, and inventing one would put a fourth value in a
   * three-value enum the schema fixes.
   */
  async closeRemaining(stepId: string, at: Date): Promise<void> {
    await this.db
      .update(approvalAssignees)
      .set({ status: 'skipped', actedAt: at })
      .where(and(eq(approvalAssignees.stepId, stepId), eq(approvalAssignees.status, 'active')));
  }

  /**
   * BR-APRV-012's read set. Any seat, any status, any step — a past approver
   * keeps timeline visibility — **and `delegate_of_user_id` counts**, because
   * BR-APRV-009 says the original approver keeps read visibility after their
   * item was re-pointed. They are the one person who would otherwise lose sight
   * of a decision made in their name.
   */
  async hasSeatOnInstance(instanceId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: approvalAssignees.id })
      .from(approvalAssignees)
      .innerJoin(approvalSteps, eq(approvalSteps.id, approvalAssignees.stepId))
      .where(and(eq(approvalSteps.instanceId, instanceId), userSeat(userId)))
      .limit(1);
    return rows.length > 0;
  }
}

function userSeat(userId: string): SQL {
  return or(
    eq(approvalAssignees.approverUserId, userId),
    eq(approvalAssignees.delegateOfUserId, userId),
  ) as SQL;
}

function toAssignee(row: typeof approvalAssignees.$inferSelect): AssigneeRow {
  return {
    id: row.id,
    stepId: row.stepId,
    approverUserId: row.approverUserId,
    delegateOfUserId: row.delegateOfUserId,
    status: row.status,
    actedAt: row.actedAt,
    version: row.version,
  };
}
