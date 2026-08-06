import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, gt, isNull, lte, or, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { settingValues } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type { CancelPlan, WritePlan } from '../domain/plan-write';
import type { SettingScope, SettingValueRow } from '../domain/setting.types';
import type {
  ExactScope,
  SettingValueHistoryRow,
  SettingValueRepositoryPort,
} from '../domain/settings.ports';

/**
 * Value rows, under the resolved tenant's context.
 *
 * No tenant predicate on reads — RLS supplies it (ADR-0002) — and writes state
 * the tenant so the policy's `WITH CHECK` re-verifies it. The interval
 * arithmetic is not here: `plan-write.ts` decides which rows move, this applies
 * the decision in one transaction (database-conventions §5 rule 4 — callers
 * never write the two rows independently).
 */
@Injectable()
export class SettingValueRepository implements SettingValueRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async listLiveForScope(scope: SettingScope, asOf: string): Promise<SettingValueRow[]> {
    const rows = await this.connection
      .handle()
      .select()
      .from(settingValues)
      .where(and(inChain(scope), liveAt(asOf)));
    return rows.map(toRow);
  }

  async listForKey(key: string, scope: SettingScope): Promise<SettingValueRow[]> {
    const rows = await this.connection
      .handle()
      .select()
      .from(settingValues)
      .where(and(eq(settingValues.key, key), inChain(scope)));
    return rows.map(toRow);
  }

  async listForKeyAtScope(key: string, scope: ExactScope): Promise<SettingValueRow[]> {
    const rows = await this.connection
      .handle()
      .select()
      .from(settingValues)
      .where(and(eq(settingValues.key, key), atScope(scope)));
    return rows.map(toRow);
  }

  async findById(id: string): Promise<SettingValueRow | null> {
    const rows = await this.connection
      .handle()
      .select()
      .from(settingValues)
      .where(eq(settingValues.id, id));
    const row = rows[0];
    return row ? toRow(row) : null;
  }

  async listHistory(
    key: string,
    scope: ExactScope,
    page: { limit: number; offset: number },
  ): Promise<{ rows: SettingValueHistoryRow[]; total: number }> {
    const db = this.connection.handle();
    const where = and(eq(settingValues.key, key), atScope(scope));

    // Sequential, not `Promise.all`: the transaction rides one `pg` socket
    // (coding-standards-nestjs §4).
    const rows = await db
      .select()
      .from(settingValues)
      .where(where)
      .orderBy(desc(settingValues.effectiveFrom), desc(settingValues.id))
      .limit(page.limit)
      .offset(page.offset);
    const totals = await db.select({ total: count() }).from(settingValues).where(where);

    return {
      rows: rows.map((row) => ({
        ...toRow(row),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  async applyWrite(key: string, scope: ExactScope, plan: WritePlan): Promise<SettingValueRow> {
    const db = this.connection.handle();
    const tenant = requireTenantContext();
    const actor = currentRequestContext()?.userId;

    // Order matters: the predecessor has to stop covering the new row's start
    // before the new row claims it, or the exclusion constraint refuses the
    // insert. Sequential awaits, not `Promise.all` — one transaction, one socket
    // (coding-standards-nestjs §4).
    if (plan.close) {
      await db
        .update(settingValues)
        .set({ effectiveTo: plan.close.effectiveTo, updatedBy: actor })
        .where(eq(settingValues.id, plan.close.id));
    }
    if (plan.drop) {
      await db.delete(settingValues).where(eq(settingValues.id, plan.drop));
    }

    const id = uuidv7();
    await db.insert(settingValues).values({
      id,
      tenantId: tenant.tenantId,
      key,
      level: scope.level,
      companyId: scope.companyId,
      branchId: scope.branchId,
      value: plan.insert.value,
      effectiveFrom: plan.insert.effectiveFrom,
      effectiveTo: plan.insert.effectiveTo,
      createdBy: actor,
      updatedBy: actor,
    });

    return {
      id,
      key,
      level: scope.level,
      companyId: scope.companyId ?? null,
      branchId: scope.branchId ?? null,
      value: plan.insert.value,
      effectiveFrom: plan.insert.effectiveFrom,
      effectiveTo: plan.insert.effectiveTo,
    };
  }

  async applyCancel(plan: CancelPlan): Promise<void> {
    const db = this.connection.handle();
    // Delete first: reopening the predecessor to `NULL` while the scheduled row
    // still exists makes the two intervals overlap, and the constraint is right
    // to refuse that.
    await db.delete(settingValues).where(eq(settingValues.id, plan.delete));
    if (plan.reopen) {
      await db
        .update(settingValues)
        .set({ effectiveTo: null, updatedBy: currentRequestContext()?.userId })
        .where(eq(settingValues.id, plan.reopen));
    }
  }
}

/**
 * The scope chain: tenant rows always, plus this company's, plus this branch's.
 * Sibling scopes are excluded here rather than in `resolveValue` so a tenant with
 * two hundred branches does not ship two hundred rows per key to the resolver.
 */
function inChain(scope: SettingScope): SQL | undefined {
  const branches: SQL[] = [eq(settingValues.level, 'tenant')];
  if (scope.companyId) {
    branches.push(
      and(eq(settingValues.level, 'company'), eq(settingValues.companyId, scope.companyId)) as SQL,
    );
  }
  if (scope.branchId) {
    branches.push(
      and(eq(settingValues.level, 'branch'), eq(settingValues.branchId, scope.branchId)) as SQL,
    );
  }
  return or(...branches);
}

function atScope(scope: ExactScope): SQL | undefined {
  return and(
    eq(settingValues.level, scope.level),
    scope.companyId
      ? eq(settingValues.companyId, scope.companyId)
      : isNull(settingValues.companyId),
    scope.branchId ? eq(settingValues.branchId, scope.branchId) : isNull(settingValues.branchId),
  );
}

/** `[effective_from, effective_to)` — database-conventions §5 rule 3, verbatim. */
function liveAt(asOf: string): SQL | undefined {
  return and(
    lte(settingValues.effectiveFrom, asOf),
    or(isNull(settingValues.effectiveTo), gt(settingValues.effectiveTo, asOf)),
  );
}

type SettingValueSelect = typeof settingValues.$inferSelect;

function toRow(row: SettingValueSelect): SettingValueRow {
  return {
    id: row.id,
    key: row.key,
    level: row.level,
    companyId: row.companyId,
    branchId: row.branchId,
    value: row.value,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}
