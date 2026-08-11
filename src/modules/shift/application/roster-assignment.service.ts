import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { patternShiftId } from '../domain/resolve';
import { shiftErrors } from '../domain/shift.errors';
import { planAssign, planCancel, type AssignRequest } from '../domain/plan-assignment';
import {
  ASSIGNMENT_REPOSITORY,
  EMPLOYEE_LOOKUP,
  PATTERN_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_REPOSITORY,
  type AssignmentRepositoryPort,
  type EmployeeLookupPort,
  type PatternRepositoryPort,
  type ScheduleCachePort,
  type ShiftOutboxPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { AssignmentRow, ShiftRow } from '../domain/shift.types';
import { WriteGuards } from './write-guards';

export interface AssignInput {
  employeeId: string | null;
  companyId: string;
  patternId: string;
  effectiveFrom: string;
  cycleAnchorDate?: string;
  note?: string | null;
}

export interface BulkAssignInput extends Omit<AssignInput, 'employeeId'> {
  employeeIds: string[];
}

export interface BulkResult {
  employeeId: string;
  success: boolean;
  assignmentId?: string;
  error?: { code: string; messageKey: string };
}

/** api-standards §10 — bulk actions cap at 100 items per call. */
export const BULK_LIMIT = 100;

/**
 * UC-SHF-004 — assign a pattern.
 *
 * Departments are a bulk-assignment affordance and never a resolution level
 * (BR-SHF-002): the UI resolves a department to employee ids and this service
 * writes **personal rows**, so the resolver never has to ask what a department
 * schedules.
 */
@Injectable()
export class RosterAssignmentService {
  constructor(
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepositoryPort,
    @Inject(PATTERN_REPOSITORY) private readonly patterns: PatternRepositoryPort,
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(SHIFT_OUTBOX) private readonly outbox: ShiftOutboxPort,
    private readonly guards: WriteGuards,
  ) {}

  /** §7: `?employeeId=` or `?companyDefault=true`, newest first, future rows included. */
  async history(filter: {
    employeeId?: string;
    companyId: string;
    companyDefault?: boolean;
  }): Promise<Result<AssignmentRow[]>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    if (filter.companyDefault)
      return ok(await this.assignments.companyDefaultHistory(filter.companyId));
    if (!filter.employeeId) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'employeeId',
            code: fieldCodes.required,
            messageKey: `errors.${fieldCodes.required}`,
            params: {},
          },
        ]),
      );
    }

    const employee = await this.employees.find(filter.employeeId);
    if (!employee || employee.companyId !== filter.companyId) return fail(sharedErrors.notFound());
    return ok(await this.assignments.history(filter.employeeId));
  }

  async assign(input: AssignInput): Promise<Result<AssignmentRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    const pattern = await this.patterns.findById(input.patternId);
    if (!pattern || pattern.companyId !== input.companyId) return fail(sharedErrors.notFound());

    let joinDate: string | null = null;
    if (input.employeeId) {
      const employee = await this.employees.find(input.employeeId);
      // §7: the company must match the employee's own — a cross-company
      // assignment is a placement error wearing a roster's clothes.
      if (!employee || employee.companyId !== input.companyId) return fail(sharedErrors.notFound());
      joinDate = employee.joinDate;
    }

    const unlocked = await this.guards.requireUnlocked(input.companyId, [input.effectiveFrom]);
    if (!unlocked.ok) return unlocked;

    const history = input.employeeId
      ? await this.assignments.liveHistory(input.employeeId)
      : await this.assignments.companyDefaultHistory(input.companyId);

    const request: AssignRequest = {
      companyId: input.companyId,
      employeeId: input.employeeId,
      patternId: input.patternId,
      effectiveFrom: input.effectiveFrom,
      cycleAnchorDate: input.cycleAnchorDate ?? input.effectiveFrom,
      note: input.note ?? null,
    };
    const plan = planAssign(history, request, joinDate);
    if (!plan.ok) return plan;

    // BR-SHF-006 across the switch-over: the outgoing pattern's last day meets
    // the incoming pattern's first, and the pair has to survive the join.
    if (input.employeeId) {
      const switchOver = await this.guards.requireNoNeighbourConflict(
        input.employeeId,
        input.effectiveFrom,
        await this.incomingShift(pattern, request.cycleAnchorDate, input.effectiveFrom),
      );
      if (!switchOver.ok) return switchOver;
    }

    try {
      const written = await this.assignments.supersede(plan.value);
      await this.announce(input.companyId, input.employeeId, input.effectiveFrom);
      return ok(written);
    } catch (error) {
      const mapped = mapExclusionViolation(error);
      if (mapped) return fail(mapped);
      throw error;
    }
  }

  /** §7's `POST /bulk-assign` — per-item results, never all-or-nothing (api-standards §10). */
  async bulkAssign(input: BulkAssignInput): Promise<Result<BulkResult[]>> {
    if (input.employeeIds.length === 0 || input.employeeIds.length > BULK_LIMIT) {
      return fail(outOfRange('employeeIds', { max: BULK_LIMIT }));
    }
    if (new Set(input.employeeIds).size !== input.employeeIds.length) {
      return fail(outOfRange('employeeIds', { duplicates: true }));
    }

    const results: BulkResult[] = [];
    for (const employeeId of input.employeeIds) {
      const assigned = await this.assign({ ...input, employeeId });
      results.push(
        assigned.ok
          ? { employeeId, success: true, assignmentId: assigned.value.id }
          : {
              employeeId,
              success: false,
              error: { code: assigned.error.code, messageKey: assigned.error.messageKey },
            },
      );
    }
    return ok(results);
  }

  /** §7's `DELETE /{id}` — future rows only, reopening the predecessor. */
  async cancel(id: string): Promise<Result<{ id: string }>> {
    const target = await this.assignments.findById(id);
    if (!target) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(target.companyId);
    if (!inScope.ok) return inScope;

    const unlocked = await this.guards.requireUnlocked(target.companyId, [target.effectiveFrom]);
    if (!unlocked.ok) return unlocked;

    const history = target.employeeId
      ? await this.assignments.liveHistory(target.employeeId)
      : await this.assignments.companyDefaultHistory(target.companyId);

    const plan = planCancel(history, target, this.guards.today());
    if (!plan.ok) return plan;

    await this.assignments.cancel(plan.value);
    await this.announce(target.companyId, target.employeeId, target.effectiveFrom);
    return ok({ id });
  }

  /** The shift the incoming pattern schedules on the switch-over date, if any. */
  private async incomingShift(
    pattern: {
      id: string;
      code: string;
      cycleLength: number;
      observesHolidays: boolean;
      days: { dayIndex: number; shiftId: string | null }[];
    },
    cycleAnchorDate: string,
    date: string,
  ): Promise<ShiftRow | null> {
    const shiftId = patternShiftId(
      {
        source: 'pattern',
        patternId: pattern.id,
        patternCode: pattern.code,
        cycleLength: pattern.cycleLength,
        observesHolidays: pattern.observesHolidays,
        cycleAnchorDate,
        days: pattern.days,
      },
      date,
    );
    if (!shiftId) return null;
    return (await this.shifts.findManyByIds([shiftId])).get(shiftId) ?? null;
  }

  /**
   * §12's `shift.roster.changed`, and §13's notification rides the same event:
   * *"batched to one message per employee per mutation batch, future dates
   * only"* — a corrected past cell is bookkeeping, a changed future shift is when
   * you show up.
   */
  private async announce(
    companyId: string,
    employeeId: string | null,
    effectiveFrom: string,
  ): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    if (employeeId) await this.cache.bustEmployee(tenantId, employeeId);
    else await this.cache.bustTenant(tenantId);

    await this.outbox.emit({
      name: 'shift.roster.changed',
      tenantId,
      aggregateId: employeeId ?? companyId,
      payload: {
        companyId,
        employeeIds: employeeId ? [employeeId] : [],
        dates: [effectiveFrom],
      },
    });
  }
}

/**
 * BR-SHF-007's constraint, surfaced as its own code. Unlike a duplicate this is
 * **not** pre-checkable: the planner closes the interval it is about to fill, so
 * a collision here means the history moved under the read — two admins assigning
 * one employee in the same instant, which is exactly what the exclusion is for.
 */
function mapExclusionViolation(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;
  return code === '23P01' && constraint === 'excl_roster_assignments_no_overlap'
    ? shiftErrors.assignmentOverlap({ constraint })
    : null;
}

function outOfRange(field: string, params: Record<string, unknown>) {
  return sharedErrors.validationFailed([
    { field, code: fieldCodes.outOfRange, messageKey: `errors.${fieldCodes.outOfRange}`, params },
  ]);
}
