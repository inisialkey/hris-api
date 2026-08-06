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

  /**
   * BPJS fiction: rates in 10%-steps no statute has ever used, caps on round
   * ten-figure numbers, a JP age ceiling of 100, a rounding unit of 1000.
   * Shape per bpjs.md §4.1/§4.2. Employee rows exist only for the programs
   * that have a seeded employee component (kesehatan, jht, jp); the JKK
   * employer row is deliberately rate-less and prices from the risk table
   * (BR-BPJS-002). Kesehatan is the one floored program here so that
   * `floor_applies` selection is observable per row.
   */
  bpjs: {
    programRates: [
      {
        program: 'kesehatan',
        payer: 'employee',
        rate: '0.1000',
        baseCap: '10000000.00',
        floorApplies: true,
      },
      {
        program: 'kesehatan',
        payer: 'employer',
        rate: '0.2000',
        baseCap: '10000000.00',
        floorApplies: true,
      },
      { program: 'jht', payer: 'employee', rate: '0.3000', baseCap: null, floorApplies: false },
      { program: 'jht', payer: 'employer', rate: '0.4000', baseCap: null, floorApplies: false },
      {
        program: 'jp',
        payer: 'employee',
        rate: '0.5000',
        baseCap: '5000000.00',
        floorApplies: false,
      },
      {
        program: 'jp',
        payer: 'employer',
        rate: '0.6000',
        baseCap: '5000000.00',
        floorApplies: false,
      },
      { program: 'jkk', payer: 'employer', rate: null, baseCap: null, floorApplies: false },
      { program: 'jkm', payer: 'employer', rate: '0.8000', baseCap: null, floorApplies: false },
    ],
    jkkRates: [
      { riskClass: 'i', rate: '0.0100' },
      { riskClass: 'ii', rate: '0.0200' },
      { riskClass: 'iii', rate: '0.0300' },
      { riskClass: 'iv', rate: '0.0400' },
      { riskClass: 'v', rate: '0.0500' },
    ],
    scalars: {
      jp_max_age_years: '100',
      kesehatan_free_dependents: '5',
      kesehatan_extra_dependent_pct: '0.1000',
      contribution_rounding_unit: '1000',
    },
  },

  /**
   * PPh 21 fiction: PTKP exactly 100,000,000 and band boundaries on round
   * millions — ADR-0018 §4's own examples. Rates in 10%-steps; a non-NPWP
   * surcharge of 100% (a doubling nobody could mistake for the real
   * percentage); PKP floors to whole millions so the down-rounding is visible
   * at a glance. `terBands` is one category's set — the adapter filters by
   * category, so the fixture carries what the calculator receives.
   */
  tax: {
    ptkpAnnualAmount: '100000000.00',
    terBands: [
      { from: '0.00', to: '10000000.00', rate: '0.1000' },
      { from: '10000000.00', to: '20000000.00', rate: '0.2000' },
      { from: '20000000.00', to: null, rate: '0.3000' },
    ],
    progressiveBands: [
      { from: '0.00', to: '100000000.00', rate: '0.1000' },
      { from: '100000000.00', to: '200000000.00', rate: '0.2000' },
      { from: '200000000.00', to: null, rate: '0.3000' },
    ],
    severanceBands: [
      { from: '0.00', to: '100000000.00', rate: '0.1000' },
      { from: '100000000.00', to: null, rate: '0.2000' },
    ],
    scalars: {
      biaya_jabatan_pct: '0.1000',
      biaya_jabatan_monthly_cap: '1000000.00',
      biaya_jabatan_annual_cap: '10000000.00',
      non_npwp_surcharge_pct: '1.0000',
      pkp_rounding_unit: '1000000.00',
      pph21_rounding_unit: '1000.00',
    },
  },

  /**
   * Payroll fiction: an overtime divisor of 100 (the statutory one is a
   * three-digit number this deliberately is not), a basis floor of exactly
   * one half, and a line rounding unit of 100 so stage rounding is visible.
   */
  payroll: {
    scalars: {
      overtime_divisor: '100.00',
      overtime_basis_floor_pct: '0.5000',
      line_rounding_unit: '100.00',
    },
  },
} as const;
