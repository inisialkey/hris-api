import { Inject, Injectable } from '@nestjs/common';

import { requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import {
  EMPLOYEE_REPOSITORY,
  type EmployeeRepositoryPort,
  FAMILY_REPOSITORY,
  type FamilyRepositoryPort,
} from '../domain/employee.ports';
import type { FamilyMemberRow } from '../domain/employee.types';

export type NewFamilyMember = Omit<FamilyMemberRow, 'id' | 'employeeId'>;

/** §7's family-member sub-resource. No module codes — the rules are all §8's. */
@Injectable()
export class FamilyService {
  constructor(
    @Inject(FAMILY_REPOSITORY) private readonly family: FamilyRepositoryPort,
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
  ) {}

  async list(employeeId: string): Promise<Result<FamilyMemberRow[]>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;
    return ok(await this.family.listFor(employeeId));
  }

  async create(employeeId: string, input: NewFamilyMember): Promise<Result<FamilyMemberRow>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;
    return ok(await this.family.create({ ...input, employeeId }));
  }

  async update(
    employeeId: string,
    memberId: string,
    patch: Partial<NewFamilyMember>,
  ): Promise<Result<FamilyMemberRow>> {
    const owned = await this.owned(employeeId, memberId);
    if (!owned.ok) return owned;

    const row = await this.family.update(memberId, patch);
    return row ? ok(row) : fail(sharedErrors.notFound());
  }

  async archive(employeeId: string, memberId: string): Promise<Result<void>> {
    const owned = await this.owned(employeeId, memberId);
    if (!owned.ok) return owned;

    return (await this.family.softDelete(memberId)) ? ok(undefined) : fail(sharedErrors.notFound());
  }

  /**
   * A member id that belongs to a different employee is 404, not 403 — the
   * nesting is ownership, so a mismatch is the same disclosure question the
   * existence-hiding rule answers everywhere else (api-standards §11).
   */
  private async owned(employeeId: string, memberId: string): Promise<Result<void>> {
    const allowed = await this.reachable(employeeId);
    if (!allowed.ok) return allowed;

    const existing = await this.family.findById(memberId);
    if (!existing || existing.employeeId !== employeeId) return fail(sharedErrors.notFound());
    return ok(undefined);
  }

  private async reachable(employeeId: string): Promise<Result<void>> {
    const employee = await this.employees.findById(employeeId);
    if (!employee) return fail(sharedErrors.notFound());
    return requireCompanyInScope(employee.companyId);
  }
}
