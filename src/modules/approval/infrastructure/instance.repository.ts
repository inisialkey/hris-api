import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { approvalInstances, approvalSteps, employeeDirectory } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type { InstanceFilter, InstanceRepositoryPort, Page, Paged } from '../domain/approval.ports';
import type {
  ChainSnapshot,
  InstanceListRow,
  InstanceRow,
  InstanceStatus,
  RequestContext,
  SlaState,
} from '../domain/approval.types';

/**
 * **Not on `TenantScopedRepository`** — BR-AUD-004: *"the approval engine's
 * `approval_actions` table is the authoritative approval trail"*. Auditing the
 * instance would write a second diff of every act the trail already records, and
 * the base's constructor assertion is what stops it from happening by accident:
 * `approval_instances` has no §4.2 entry, so extending the base would fail at
 * module init.
 *
 * Channel 2 covers what audit does want — the terminal events, consumed as
 * headlines (audit-log §12).
 */
@Injectable()
export class InstanceRepository implements InstanceRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  async create(values: {
    companyId: string;
    requestType: string;
    requestId: string;
    requesterEmployeeId: string;
    requesterUserId: string;
    chainSnapshot: ChainSnapshot;
    context: RequestContext;
  }): Promise<InstanceRow> {
    const actor = currentRequestContext()?.userId;
    const inserted = await this.db
      .insert(approvalInstances)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        ...values,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return toInstance(inserted[0]!);
  }

  async findById(id: string): Promise<InstanceRow | null> {
    const rows = await this.db.select().from(approvalInstances).where(eq(approvalInstances.id, id));
    return rows[0] ? toInstance(rows[0]) : null;
  }

  async findNewestForRequest(requestType: string, requestId: string): Promise<InstanceRow | null> {
    const rows = await this.db
      .select()
      .from(approvalInstances)
      .where(
        and(
          eq(approvalInstances.requestType, requestType),
          eq(approvalInstances.requestId, requestId),
        ),
      )
      .orderBy(desc(approvalInstances.id))
      .limit(1);
    return rows[0] ? toInstance(rows[0]) : null;
  }

  async previousInstanceIds(
    requestType: string,
    requestId: string,
    exceptId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ id: approvalInstances.id })
      .from(approvalInstances)
      .where(
        and(
          eq(approvalInstances.requestType, requestType),
          eq(approvalInstances.requestId, requestId),
          ne(approvalInstances.id, exceptId),
        ),
      )
      .orderBy(desc(approvalInstances.id));
    return rows.map((row) => row.id);
  }

  /**
   * §7's oversight grid. The requester's name comes from `employee_directory`
   * (ADR-0001 rule 6) — the engine may not join `employees`, and a grid that
   * renders "who asked" cannot resolve a page of names through a port without a
   * second round trip per row.
   *
   * Step counts and SLA state arrive in a **second** query rather than a lateral
   * join: both are aggregates over `approval_steps` for the page's instances,
   * and one grouped read of a bounded id list is cheaper to write, cheaper to
   * read, and cheaper to explain than a correlated subquery per column.
   */
  async list(filter: InstanceFilter, page: Page): Promise<Paged<InstanceListRow>> {
    const where = and(...this.filters(filter));

    const rows = await this.db
      .select({
        instance: approvalInstances,
        requesterName: employeeDirectory.fullName,
      })
      .from(approvalInstances)
      .leftJoin(
        employeeDirectory,
        eq(employeeDirectory.employeeId, approvalInstances.requesterEmployeeId),
      )
      .where(where)
      .orderBy(desc(approvalInstances.id))
      .limit(page.limit)
      .offset(page.offset);

    const totals = await this.db.select({ value: count() }).from(approvalInstances).where(where);
    const stats = await this.stepStats(rows.map((row) => row.instance.id));

    return {
      rows: rows.map(({ instance, requesterName }) => {
        const stat = stats.get(instance.id);
        return {
          id: instance.id,
          requestType: instance.requestType,
          requestId: instance.requestId,
          requesterEmployeeId: instance.requesterEmployeeId,
          requesterName,
          status: instance.status,
          currentStepIndex: instance.currentStepIndex,
          stepCount: stat?.stepCount ?? 0,
          isStuck: instance.isStuck,
          slaState: slaStateOf(instance.isStuck, stat),
          createdAt: instance.createdAt,
          completedAt: instance.completedAt,
        };
      }),
      total: totals[0]?.value ?? 0,
    };
  }

  async advance(
    id: string,
    version: number,
    patch: { currentStepIndex?: number; status?: InstanceStatus; isStuck?: boolean },
    completedAt?: Date,
  ): Promise<boolean> {
    const updated = await this.db
      .update(approvalInstances)
      .set({
        ...patch,
        ...(completedAt ? { completedAt } : {}),
        version: version + 1,
        updatedBy: currentRequestContext()?.userId,
      })
      .where(and(eq(approvalInstances.id, id), eq(approvalInstances.version, version)))
      .returning({ id: approvalInstances.id });
    return updated.length > 0;
  }

  private async stepStats(instanceIds: string[]): Promise<Map<string, StepStat>> {
    if (instanceIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        instanceId: approvalSteps.instanceId,
        stepCount: count(),
        reminded: sql<number>`count(*) filter (where ${approvalSteps.status} = 'active' and ${approvalSteps.remindedAt} is not null)`,
        escalated: sql<number>`count(*) filter (where ${approvalSteps.status} = 'active' and ${approvalSteps.escalatedAt} is not null)`,
      })
      .from(approvalSteps)
      .where(inArray(approvalSteps.instanceId, instanceIds))
      .groupBy(approvalSteps.instanceId);

    return new Map(
      rows.map((row) => [
        row.instanceId,
        {
          stepCount: row.stepCount,
          reminded: Number(row.reminded) > 0,
          escalated: Number(row.escalated) > 0,
        },
      ]),
    );
  }

  private filters(filter: InstanceFilter): SQL[] {
    const predicates: SQL[] = [];
    if (filter.requestType) predicates.push(eq(approvalInstances.requestType, filter.requestType));
    if (filter.status) predicates.push(eq(approvalInstances.status, filter.status));
    if (filter.stuck !== undefined) predicates.push(eq(approvalInstances.isStuck, filter.stuck));
    if (filter.companyId) predicates.push(eq(approvalInstances.companyId, filter.companyId));
    if (filter.companyIds) {
      predicates.push(
        filter.companyIds.length === 0
          ? sql`false`
          : inArray(approvalInstances.companyId, filter.companyIds),
      );
    }
    // `slaState` filters on the live step's stamps, which live on another table.
    // A subquery over `idx_approval_steps_sla_scan` rather than a join: the grid
    // is one row per instance and a join to a step set would have to de-duplicate.
    if (filter.slaState) {
      const stamp =
        filter.slaState === 'escalated' ? approvalSteps.escalatedAt : approvalSteps.remindedAt;
      predicates.push(
        inArray(
          approvalInstances.id,
          this.db
            .select({ instanceId: approvalSteps.instanceId })
            .from(approvalSteps)
            .where(and(eq(approvalSteps.status, 'active'), isNotNull(stamp))),
        ),
      );
    }
    return predicates;
  }
}

interface StepStat {
  stepCount: number;
  reminded: boolean;
  escalated: boolean;
}

/** Escalated outranks reminded outranks stuck-free: §7's column is the worst news. */
function slaStateOf(isStuck: boolean, stat: StepStat | undefined): SlaState {
  if (isStuck) return 'stuck';
  if (stat?.escalated) return 'escalated';
  if (stat?.reminded) return 'reminded';
  return 'ok';
}

type InstanceRecord = typeof approvalInstances.$inferSelect;

function toInstance(row: InstanceRecord): InstanceRow {
  return {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    requestId: row.requestId,
    requesterEmployeeId: row.requesterEmployeeId,
    requesterUserId: row.requesterUserId,
    status: row.status,
    chainSnapshot: row.chainSnapshot as ChainSnapshot,
    context: row.context as RequestContext,
    currentStepIndex: row.currentStepIndex,
    isStuck: row.isStuck,
    version: row.version,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
