import type { AppError } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { employeeErrors } from '../domain/employee.errors';

export function duplicate(field: string): AppError {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.duplicate,
      messageKey: `errors.${fieldCodes.duplicate}`,
      params: { field },
    },
  ]);
}

export function required(field: string): AppError {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.required,
      messageKey: `errors.${fieldCodes.required}`,
      params: { field },
    },
  ]);
}

export function outOfRange(field: string, params: Record<string, unknown>): AppError {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.outOfRange,
      messageKey: `errors.${fieldCodes.outOfRange}`,
      params: { field, ...params },
    },
  ]);
}

/**
 * PostgreSQL constraint violations that are **not** pre-checkable.
 *
 * Duplicate NIK and NPWP are pre-checked, because §7 wants a `VAL_DUPLICATE`
 * entry naming the field and a constraint name cannot say which field it was.
 * Contract overlap is the opposite case: two admins renewing one employee in
 * the same instant is precisely the race `excl_employee_contracts_no_overlap`
 * exists to lose gracefully, and no pre-check could win it.
 */
export function mapConstraintViolation(error: unknown): AppError | null {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;

  if (code === '23P01' && constraint === 'excl_employee_contracts_no_overlap') {
    return employeeErrors.contractOverlap({ conflictingContractId: null });
  }
  // The unique indexes are the guard for a NIK race the pre-check lost. The
  // field is recoverable from the index name here, unlike an exclusion.
  if (code === '23505' && constraint === 'uq_employees_tenant_id_nik_bidx') {
    return duplicate('nik');
  }
  if (code === '23505' && constraint === 'uq_employees_tenant_id_npwp_bidx') {
    return duplicate('npwp');
  }
  if (code === '23505' && constraint === 'uq_employees_tenant_id_company_id_number') {
    return duplicate('employeeNumber');
  }
  return null;
}
