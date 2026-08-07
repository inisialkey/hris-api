import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalSteps } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { StepRepositoryPort } from '../domain/approval.ports';
import type { StepConfig, StepRow, StepStatus } from '../domain/approval.types';

/** Not audited, for `InstanceRepository`'s reason (BR-AUD-004). */
@Injectable()
export class StepRepository implements StepRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  /**
   * Every step of the snapshot, `pending`, in one statement. All of them exist
   * from submit — §4's step lifecycle starts at `pending`, and an oversight
   * reader asking "how many steps does this have" is asking about the snapshot,
   * not about how far it got.
   */
  async createAll(instanceId: string, steps: readonly StepConfig[]): Promise<StepRow[]> {
    const tenantId = requireTenantContext().tenantId;
    const inserted = await this.db
      .insert(approvalSteps)
      .values(
        steps.map((step, index) => ({
          id: uuidv7(),
          tenantId,
          instanceId,
          stepIndex: index,
          name: step.name ?? null,
          quorum: step.quorum,
          slaHours: step.slaHours ?? null,
        })),
      )
      .returning();
    return inserted.map(toStep);
  }

  async listByInstance(instanceId: string): Promise<StepRow[]> {
    const rows = await this.db
      .select()
      .from(approvalSteps)
      .where(eq(approvalSteps.instanceId, instanceId))
      .orderBy(asc(approvalSteps.stepIndex));
    return rows.map(toStep);
  }

  async findByIndex(instanceId: string, stepIndex: number): Promise<StepRow | null> {
    const rows = await this.db
      .select()
      .from(approvalSteps)
      .where(and(eq(approvalSteps.instanceId, instanceId), eq(approvalSteps.stepIndex, stepIndex)));
    return rows[0] ? toStep(rows[0]) : null;
  }

  async activate(id: string, version: number, at: Date): Promise<boolean> {
    return this.guarded(id, version, { status: 'active', activatedAt: at });
  }

  /**
   * BR-APRV-013's step-level optimistic check, and the one that decides an
   * `any`-quorum race: two approvers both claim their own assignee rows, then
   * both try to move the step off `active`. One `UPDATE` matches, the other
   * returns zero rows and its whole transaction — claim included — rolls back.
   */
  async decide(id: string, version: number, status: StepStatus, at: Date): Promise<boolean> {
    return this.guarded(id, version, { status, decidedAt: at });
  }

  async stamp(id: string, column: 'remindedAt' | 'escalatedAt', at: Date): Promise<void> {
    await this.db
      .update(approvalSteps)
      .set({ [column]: at })
      .where(eq(approvalSteps.id, id));
  }

  /**
   * BR-APRV-015 wants a `skipped` row for a step the instance never reached, so
   * a timeline shows three steps of which two never ran rather than two steps
   * and a gap. No version guard: the instance is already terminal, so nothing
   * else is moving these rows.
   */
  async skipRemaining(instanceId: string, fromIndex: number): Promise<void> {
    await this.db
      .update(approvalSteps)
      .set({ status: 'skipped', version: sql`${approvalSteps.version} + 1` })
      .where(
        and(
          eq(approvalSteps.instanceId, instanceId),
          gte(approvalSteps.stepIndex, fromIndex),
          eq(approvalSteps.status, 'pending'),
        ),
      );
  }

  /**
   * UC-APRV-007's scan. `activated_at + sla_hours <= now` is computed in SQL
   * against a `now` the **`Clock` port** supplied — §9's "no client time" holds
   * (nothing here comes from a phone or a browser) and the port is what lets the
   * ladder be tested at all, since a `now()` in the statement would leave the
   * two thresholds unreachable from a test.
   *
   * Returns everything past its first threshold; the caller decides which rung
   * each row is on, because the two rungs share this read.
   */
  async dueForSla(now: Date): Promise<StepRow[]> {
    const rows = await this.db
      .select()
      .from(approvalSteps)
      .where(
        and(
          eq(approvalSteps.status, 'active'),
          isNotNull(approvalSteps.slaHours),
          isNotNull(approvalSteps.activatedAt),
          lte(
            sql`${approvalSteps.activatedAt} + make_interval(hours => ${approvalSteps.slaHours})`,
            now,
          ),
          // Nothing to do once both stamps are set — the ladder has two rungs.
          isNull(approvalSteps.escalatedAt),
        ),
      )
      .orderBy(asc(approvalSteps.activatedAt));
    return rows.map(toStep);
  }

  private async guarded(
    id: string,
    version: number,
    patch: Partial<typeof approvalSteps.$inferInsert>,
  ): Promise<boolean> {
    const updated = await this.db
      .update(approvalSteps)
      .set({ ...patch, version: version + 1 })
      .where(and(eq(approvalSteps.id, id), eq(approvalSteps.version, version)))
      .returning({ id: approvalSteps.id });
    return updated.length > 0;
  }
}

function toStep(row: typeof approvalSteps.$inferSelect): StepRow {
  return {
    id: row.id,
    instanceId: row.instanceId,
    stepIndex: row.stepIndex,
    name: row.name,
    quorum: row.quorum,
    slaHours: row.slaHours,
    status: row.status,
    activatedAt: row.activatedAt,
    remindedAt: row.remindedAt,
    escalatedAt: row.escalatedAt,
    decidedAt: row.decidedAt,
    version: row.version,
  };
}
