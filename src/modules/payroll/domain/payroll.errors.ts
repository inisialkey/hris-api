import { AppError } from '../../../shared/app-error';

/**
 * The only place this module spells its codes (backend-nestjs §7.3) — of the
 * catalog's PAY_ block, the pipeline raises exactly one; the rest belong to
 * run endpoints and jobs that arrive with the module.
 */
export const payrollErrors = {
  parameterMissing: (parameter: string, asOf: string) =>
    new AppError('PAY_PARAMETER_MISSING', { parameter, asOf }),
} as const;

/** Status registration arrives with `payroll.module.ts` (one-owner: this block). */
export const payrollErrorStatus = {
  PAY_PARAMETER_MISSING: 422,
} as const;
