import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { toBusinessDate } from '../domain/dates';
import {
  CONTRACT_REPOSITORY,
  type ContractRepositoryPort,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepositoryPort,
} from '../domain/employee.ports';
import type { ContractRow, EmploymentType } from '../domain/employee.types';
import { mapConstraintViolation, required } from './field-errors';

export interface NewContract {
  kind: EmploymentType;
  startDate: string;
  endDate?: string | null;
  fileId?: string | null;
  note?: string | null;
}

/**
 * UC-EMP-008. Renewal is a **new row** (BR-EMP-007), never an edit of the
 * expiring one — which is what keeps the reminder ladder's `last_reminded_days`
 * stamp meaningful and what makes the contract timeline a history rather than a
 * current value with a memory.
 *
 * `employees.employment_type` is re-derived after every write. It is a mirror of
 * the row current *today*, so a PKWT renewed as PKWTT flips it and a future-dated
 * renewal does not — which is why the derivation reads the date rather than the
 * row just written.
 */
@Injectable()
export class ContractService {
  constructor(
    @Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepositoryPort,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(employeeId: string): Promise<Result<ContractRow[]>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;
    return ok(await this.contracts.listFor(employeeId));
  }

  async create(employeeId: string, input: NewContract): Promise<Result<ContractRow>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;

    if (input.kind === 'pkwt' && !input.endDate) return fail(required('endDate'));

    try {
      const row = await this.contracts.create({
        employeeId,
        kind: input.kind,
        startDate: input.startDate,
        endDate: input.kind === 'pkwt' ? (input.endDate ?? null) : null,
        fileId: input.fileId ?? null,
        note: input.note ?? null,
      });
      await this.syncEmploymentType(employeeId);
      return ok(row);
    } catch (error) {
      return this.mapped(error);
    }
  }

  async update(
    employeeId: string,
    contractId: string,
    patch: Partial<Pick<ContractRow, 'startDate' | 'endDate' | 'fileId' | 'note'>>,
  ): Promise<Result<ContractRow>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;

    const existing = await this.contracts.findById(contractId);
    if (!existing || existing.employeeId !== employeeId) return fail(sharedErrors.notFound());
    if (existing.kind === 'pkwt' && patch.endDate === null) return fail(required('endDate'));

    try {
      const row = await this.contracts.update(contractId, patch);
      if (!row) return fail(sharedErrors.notFound());
      await this.syncEmploymentType(employeeId);
      return ok(row);
    } catch (error) {
      return this.mapped(error);
    }
  }

  /**
   * §7: the last remaining contract row cannot be deleted. An employee always
   * has a contract — BR-EMP-002 writes one at hire — so a row set that can
   * empty would make `employment_type` a value with no source.
   */
  async archive(employeeId: string, contractId: string): Promise<Result<void>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;

    const existing = await this.contracts.findById(contractId);
    if (!existing || existing.employeeId !== employeeId) return fail(sharedErrors.notFound());

    if ((await this.contracts.countFor(employeeId)) <= 1) {
      return fail(required('contractId'));
    }

    const deleted = await this.contracts.softDelete(contractId);
    if (!deleted) return fail(sharedErrors.notFound());
    await this.syncEmploymentType(employeeId);
    return ok(undefined);
  }

  private async syncEmploymentType(employeeId: string): Promise<void> {
    const current = await this.contracts.currentAt(employeeId, toBusinessDate(this.clock.now()));
    if (current) await this.employees.setEmploymentType(employeeId, current.kind);
  }

  private async reachable(employeeId: string): Promise<Result<void>> {
    const employee = await this.employees.findById(employeeId);
    if (!employee) return fail(sharedErrors.notFound());
    return requireCompanyInScope(employee.companyId);
  }

  private mapped(error: unknown): Result<never> {
    const mapped = mapConstraintViolation(error);
    if (mapped) return fail(mapped);
    throw error;
  }
}
