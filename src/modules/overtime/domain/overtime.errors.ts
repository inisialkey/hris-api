import { AppError } from '../../../shared/app-error';

/**
 * The only place `OVT_` codes are spelled (backend-nestjs §7.3). The catalog
 * (`error-catalog.md` §20) registers ten; this factory carries the one the
 * pricing calculator raises — the other nine arrive with the endpoints and
 * jobs that raise them.
 *
 * `malformed` rides `OVT_RATE_RULES_MISSING` rather than a new code: the
 * catalog defines the code as "no effective multiplier row set", and a set the
 * walk cannot trust is that condition one notch later. A new code would need a
 * catalog registration for a state only a broken migration can produce (A-187).
 */
export const overtimeErrors = {
  rateRulesMissing: (params: {
    dayClass: string;
    reason: 'no_rows' | 'malformed';
    detail?: string;
  }) => new AppError('OVT_RATE_RULES_MISSING', params),
} as const;

/** Registered via `registerErrorStatuses` when `overtime.module.ts` arrives. */
export const overtimeErrorStatus = {
  OVT_RATE_RULES_MISSING: 422,
} as const;
