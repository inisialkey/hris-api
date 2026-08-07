import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { PERIOD_LOCK_PORT, type PeriodLockPort } from '../../../shared/period-lock.port';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { organizationErrors } from '../domain/organization.errors';
import {
  ASSIGNMENT_REPOSITORY,
  BRANCH_REPOSITORY,
  EMPLOYEE_LOOKUP,
  ORGANIZATION_OUTBOX,
  PLACEMENT_CACHE,
  POSITION_REPOSITORY,
  type AssignmentHistoryRow,
  type AssignmentRepositoryPort,
  type BranchRepositoryPort,
  type EmployeeLookupPort,
  type OrganizationOutboxPort,
  type PlacementCachePort,
  type PositionRepositoryPort,
} from '../domain/organization.ports';
import type { AssignmentRow, MoveRequest } from '../domain/organization.types';
import { planCancel, planMove } from '../domain/plan-placement';
import { mapConstraintViolation } from './field-errors';
import { requireCompanyInScope } from '../../../shared/data-scope';

/**
 * UC-ORG-003 and UC-ORG-004 — the only two writes to `org_assignments` that a
 * human performs, plus the two `OrgPlacementPort` calls that employee.md will
 * make from inside its own transaction.
 *
 * The order of the checks is the rule set, top to bottom: the employee must
 * exist and be in scope, the target must belong to their company, the date must
 * be outside a locked period, and only then does the planner get to decide where
 * the row goes.
 */
@Injectable()
export class MoveUseCase {
  constructor(
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepositoryPort,
    @Inject(POSITION_REPOSITORY) private readonly positions: PositionRepositoryPort,
    @Inject(BRANCH_REPOSITORY) private readonly branches: BranchRepositoryPort,
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(PERIOD_LOCK_PORT) private readonly periods: PeriodLockPort,
    @Inject(PLACEMENT_CACHE) private readonly cache: PlacementCachePort,
    @Inject(ORGANIZATION_OUTBOX) private readonly outbox: OrganizationOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async history(employeeId: string): Promise<Result<AssignmentHistoryRow[]>> {
    const employee = await this.employees.find(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    return ok(await this.assignments.fullHistory(employeeId));
  }

  async move(employeeId: string, request: MoveRequest): Promise<Result<AssignmentRow>> {
    const employee = await this.employees.find(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    const agreement = await this.sameCompany(employee.companyId, request);
    if (!agreement.ok) return agreement;

    const unlocked = await this.requireUnlocked(employeeId, request.effectiveFrom);
    if (!unlocked.ok) return unlocked;

    const history = await this.assignments.liveHistory(employeeId);
    const plan = planMove(history, request, employee.joinDate);
    if (!plan.ok) return plan;

    try {
      const row = await this.assignments.supersede(employeeId, plan.value);
      await this.announce(employeeId, row);
      return ok(row);
    } catch (error) {
      const mapped = mapConstraintViolation(error);
      if (mapped) return fail(mapped);
      throw error;
    }
  }

  async cancel(employeeId: string, assignmentId: string): Promise<Result<{ id: string }>> {
    const employee = await this.employees.find(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    const target = await this.assignments.findById(assignmentId);
    if (!target || target.employeeId !== employeeId) return fail(sharedErrors.notFound());

    const unlocked = await this.requireUnlocked(employeeId, target.effectiveFrom);
    if (!unlocked.ok) return unlocked;

    const history = await this.assignments.liveHistory(employeeId);
    const plan = planCancel(history, target, this.today());
    if (!plan.ok) return plan;

    await this.assignments.cancel(plan.value);
    await this.announce(employeeId, target);
    return ok({ id: assignmentId });
  }

  /**
   * BR-ORG-002's hire seed. No period-lock check and no scope check: the caller
   * is employee.md creating the employee inside its own transaction, the join
   * date is by definition the first date this person has, and there is no earlier
   * placement for a lock to be protecting.
   */
  async assignOnHire(
    employeeId: string,
    positionId: string,
    branchId: string,
    effectiveFrom: string,
  ): Promise<Result<void>> {
    const employee = await this.employees.find(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const agreement = await this.sameCompany(employee.companyId, { positionId, branchId });
    if (!agreement.ok) return agreement;

    const history = await this.assignments.liveHistory(employeeId);
    const plan = planMove(
      history,
      { positionId, branchId, kind: 'hire', effectiveFrom },
      employee.joinDate,
    );
    if (!plan.ok) return plan;

    const row = await this.assignments.supersede(employeeId, plan.value);
    await this.announce(employeeId, row);
    return ok(undefined);
  }

  /** BR-EMP-006's effectuation. Silent when nothing is live — an exit can follow an exit. */
  async closeOnExit(employeeId: string, effectiveDate: string): Promise<Result<void>> {
    const closed = await this.assignments.closeLiveAt(employeeId, effectiveDate);
    if (closed) await this.cache.bust(requireTenantContext().tenantId, employeeId);
    return ok(undefined);
  }

  /**
   * BR-ORG-002. Both sides are read in the employee's company, so a target in
   * another company of the same tenant is `ORG_CROSS_COMPANY` while a target that
   * does not exist at all is 404 — the caller can tell "wrong company" from
   * "wrong id", which is what makes the error actionable in the move dialog.
   */
  private async sameCompany(
    companyId: string,
    target: { positionId: string; branchId: string },
  ): Promise<Result<void>> {
    const position = await this.positions.findById(target.positionId);
    const branch = await this.branches.findById(target.branchId);
    if (!position || !branch) return fail(sharedErrors.notFound());
    if (position.companyId !== companyId || branch.companyId !== companyId) {
      return fail(organizationErrors.crossCompany());
    }
    return ok(undefined);
  }

  /**
   * BR-ORG-008. Placement drives proration and cost attribution, so a date inside
   * a closed attendance or payroll period is immutable — the correction lands on
   * the first open date instead, and the retro effects are payroll's mechanism
   * rather than a placement rewrite (§9).
   */
  private async requireUnlocked(employeeId: string, date: string): Promise<Result<void>> {
    const lock = await this.periods.lockAt(employeeId, date);
    return lock
      ? fail(organizationErrors.periodLocked({ periodId: lock.periodId }))
      : ok(undefined);
  }

  /**
   * One bust and one event per placement change. The bust is immediate because
   * attendance derivation reads the cache per punch; the event is what shift and
   * employee react to, and what makes the bust survive a process that is not the
   * one holding the cached entry.
   */
  private async announce(employeeId: string, row: AssignmentRow): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    await this.cache.bust(tenantId, employeeId);
    await this.outbox.emit({
      name: 'organization.assignment.changed',
      tenantId,
      aggregateId: employeeId,
      payload: {
        employeeId,
        positionId: row.positionId,
        branchId: row.branchId,
        effectiveFrom: row.effectiveFrom,
      },
    });
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}
