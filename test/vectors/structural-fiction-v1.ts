import type { OvertimeRateRule } from '../../src/modules/overtime/domain/overtime-pricing';

/**
 * `structural-fiction-v1` — the deliberately fictional rate set (ADR-0018 §4).
 *
 * THESE VALUES ARE FICTION AND MUST STAY FICTION. Every factor is exactly 2.00,
 * chosen so that nobody can mistake this file for Indonesian regulation, cite
 * it in a compliance conversation, or "correct" a value to a plausible one —
 * doing so would destroy the property that makes the structural suite honest.
 * Real rates enter only through the platform rate-set path, confirmed by a
 * human against current regulation (ai-development-guide §5).
 *
 * With a uniform factor the *total* cannot distinguish a wrong tier split from
 * a right one — which is why every structural vector asserts the `tiers` trace,
 * not just `multiplierHours`.
 *
 * Grows one section per calculator as track 2 proceeds (tax PTKP 100000000,
 * TER bands on round millions, JKK 0.0100, BPJS caps at round numbers). The
 * statutory-parameter seed migration must hold this same set — one rate set,
 * two consumers, nothing to drift (ADR-0018 §4, extended to seeds).
 */
export const structuralFictionV1 = {
  rateSet: 'structural-fiction-v1',

  /** Shape per overtime.md §4.2; factors fictional per ADR-0018 §4. */
  overtimeRateRules: [
    {
      dayClass: 'work_day',
      tierIndex: 0,
      boundsBasis: 'absolute',
      fromHour: null,
      toHour: '1.00',
      factor: '2.00',
    },
    {
      dayClass: 'work_day',
      tierIndex: 1,
      boundsBasis: 'absolute',
      fromHour: '1.00',
      toHour: null,
      factor: '2.00',
    },
    {
      dayClass: 'rest_day',
      tierIndex: 0,
      boundsBasis: 'standard_day',
      fromHour: null,
      toHour: '0.00',
      factor: '2.00',
    },
    {
      dayClass: 'rest_day',
      tierIndex: 1,
      boundsBasis: 'standard_day',
      fromHour: '0.00',
      toHour: '1.00',
      factor: '2.00',
    },
    {
      dayClass: 'rest_day',
      tierIndex: 2,
      boundsBasis: 'standard_day',
      fromHour: '1.00',
      toHour: null,
      factor: '2.00',
    },
  ] satisfies OvertimeRateRule[],
} as const;
