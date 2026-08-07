import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { toBusinessDate } from '../domain/dates';
import { employeeErrors } from '../domain/employee.errors';
import {
  EMPLOYEE_REPOSITORY,
  type EmployeeRepositoryPort,
  STATUS_HISTORY_REPOSITORY,
  type StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import { canTransition } from '../domain/status-machine';
import { outOfRange } from './field-errors';
import { EffectuateService } from './effectuate.service';

export interface TerminateResult {
  id: string;
  status: string;
  effectiveDate: string;
  applied: boolean;
}

/**
 * UC-EMP-006. Today effectuates inline, a future date schedules — the
 * difference is one call, and the same {@link EffectuateService} runs
 * BR-EMP-006's effect set either way, so an inline termination is not a second
 * implementation of an exit.
 */
@Injectable()
export class TerminateUseCase {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(STATUS_HISTORY_REPOSITORY) private readonly history: StatusHistoryRepositoryPort,
    private readonly effectuate: EffectuateService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    employeeId: string,
    input: { effectiveDate: string; reason: string },
  ): Promise<Result<TerminateResult>> {
    const employee = await this.employees.findById(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    if (!canTransition(employee.status, 'terminated')) {
      return fail(employeeErrors.statusTransitionInvalid({ currentStatus: employee.status }));
    }

    // §9 — one pending terminal transition at a time. Without it a scheduled
    // resignation and a scheduled termination would both effectuate, and the
    // second would try to transition out of a terminal state.
    if (await this.history.pendingTerminalFor(employeeId)) {
      return fail(employeeErrors.statusTransitionInvalid({ currentStatus: employee.status }));
    }

    const today = toBusinessDate(this.clock.now());
    if (input.effectiveDate < today) {
      return fail(outOfRange('effectiveDate', { min: today }));
    }
    if (input.effectiveDate < employee.joinDate) {
      return fail(outOfRange('effectiveDate', { min: employee.joinDate }));
    }

    const row = await this.history.insert({
      employeeId,
      status: 'terminated',
      source: 'termination',
      effectiveDate: input.effectiveDate,
      reason: input.reason,
    });

    const applied = input.effectiveDate <= today ? await this.effectuate.apply(row) : false;

    return ok({
      id: employeeId,
      status: applied ? 'terminated' : employee.status,
      effectiveDate: input.effectiveDate,
      applied,
    });
  }
}
