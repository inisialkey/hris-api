import type { AppError } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { organizationErrors } from '../domain/organization.errors';

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

/**
 * PostgreSQL constraint violations that are **not** pre-checkable.
 *
 * Duplicate codes are pre-checked in the services, because a `VAL_DUPLICATE`
 * entry has to name the field and a constraint name does not. The assignment
 * exclusion is the opposite case: the planner already closes the interval it is
 * about to fill, so a collision here means the history moved under the read —
 * two admins moving one employee in the same instant. That race is exactly what
 * the constraint is for, and there is no pre-check that could win it.
 */
export function mapConstraintViolation(error: unknown): AppError | null {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;

  if (code === '23P01' && constraint === 'excl_org_assignments_no_overlap') {
    return organizationErrors.assignmentOverlap({ conflictingAssignmentId: null });
  }
  return null;
}
