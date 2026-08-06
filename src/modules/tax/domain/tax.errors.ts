import { AppError } from '../../../shared/app-error';

/**
 * The only place this module spells catalog codes (backend-nestjs §7.3).
 *
 * `PAY_PARAMETER_MISSING` is a sanctioned reuse (tax-pph21.md §11): payroll
 * raises it at run creation with the same `{ parameter, asOf }` shape, and a
 * second code for the same condition would split the branch clients write.
 * The module's own five codes belong to endpoints and jobs that arrive with
 * the module — the calculator never raises them.
 *
 * `grossUpUnsolvable` also rides it: an effective rate ≥ 100% makes the
 * gross-up closed form divide by zero, which only a broken parameter row set
 * can produce — the defect is named in `details`.
 */
export const taxErrors = {
  parameterMissing: (parameter: string, asOf: string) =>
    new AppError('PAY_PARAMETER_MISSING', { parameter, asOf }),
  grossUpUnsolvable: (rate: string, surchargeFactor: string) =>
    new AppError('PAY_PARAMETER_MISSING', {
      parameter: 'tax_ter_rates',
      reason: 'gross_up_unsolvable',
      rate,
      surchargeFactor,
    }),
} as const;
