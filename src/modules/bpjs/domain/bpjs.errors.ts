import { AppError } from '../../../shared/app-error';

/**
 * The only place this module spells catalog codes (backend-nestjs §7.3).
 *
 * `PAY_PARAMETER_MISSING` is a sanctioned reuse, not a new code: bpjs.md §11
 * reuses it for an absent statutory version exactly as tax-pph21.md does, with
 * the same `{ parameter, asOf }` shape payroll raises at run creation. The
 * module's own three codes (`BPJS_REGISTRATION_OVERLAP`, `BPJS_COVERAGE_OVERLAP`,
 * `BPJS_RISK_CLASS_REQUIRED`) belong to write endpoints that arrive with the
 * module — the calculator never raises them.
 */
export const bpjsErrors = {
  parameterMissing: (parameter: string, asOf: string) =>
    new AppError('PAY_PARAMETER_MISSING', { parameter, asOf }),
} as const;

/**
 * No status registration here: `PAY_PARAMETER_MISSING`'s status belongs to
 * payroll's block (one-owner rule), and this module's own codes register when
 * `bpjs.module.ts` arrives.
 */
