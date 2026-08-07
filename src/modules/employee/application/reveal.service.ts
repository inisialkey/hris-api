import { Inject, Injectable } from '@nestjs/common';

import { requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { AUDIT_PORT, type AuditPort } from '../../audit';
import { EMPLOYEE_REPOSITORY, type EmployeeRepositoryPort } from '../domain/employee.ports';
import type { EmployeeRow } from '../domain/employee.types';

export interface RevealedValues {
  nik: string;
  npwp: string | null;
  bpjsKesehatanNumber: string | null;
  bpjsKetenagakerjaanNumber: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
}

/**
 * UC-EMP-003 — the only full-value path (BR-EMP-003), and a registered
 * sensitive read (`employee.sensitive.revealed`, audit-log §4.3).
 *
 * **The audit insert precedes the response and nothing catches it.** UC-AUD-003
 * is fail-closed: a `try/catch` around it would turn the module's central
 * promise — that no one reads a NIK without leaving a record — into a best
 * effort, silently. If the trail cannot be written the values are not returned,
 * and the caller gets `SYS_INTERNAL`.
 *
 * Two callers, one implementation: `/employees/{id}/sensitive` under
 * `employee.sensitive.read`, and `/me/profile/sensitive` under nothing but
 * authentication, because an employee revealing their own bank account is
 * self-scope by construction. Both write the same audit row — §4.3 registers the
 * key, not the route.
 */
@Injectable()
export class RevealService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
  ) {}

  /** Admin path — scope-checked, then audited. */
  async reveal(employeeId: string): Promise<Result<RevealedValues>> {
    const employee = await this.employees.findById(employeeId);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    return this.audited(employee);
  }

  /** Self path — the subject is the scope check. */
  async revealOwn(userId: string): Promise<Result<RevealedValues>> {
    const employee = await this.employees.findByUserId(userId);
    if (!employee) return fail(sharedErrors.notFound());

    return this.audited(employee);
  }

  private async audited(employee: EmployeeRow): Promise<Result<RevealedValues>> {
    await this.audit.sensitiveRead('employee.sensitive.revealed', 'employees', employee.id);

    return ok({
      nik: employee.nik,
      npwp: employee.npwp,
      bpjsKesehatanNumber: employee.bpjsKesehatanNumber,
      bpjsKetenagakerjaanNumber: employee.bpjsKetenagakerjaanNumber,
      bankName: employee.bankName,
      bankAccountNumber: employee.bankAccountNumber,
      bankAccountHolder: employee.bankAccountHolder,
    });
  }
}
