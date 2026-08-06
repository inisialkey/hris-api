import Decimal from 'decimal.js';

import { AppError } from '../../../shared/app-error';
import { fail, ok, Result } from '../../../shared/result';
import { bpjsErrors } from './bpjs.errors';

/**
 * The BPJS contribution calculator — bpjs.md §4.3's resolution ladder and
 * §4.4's contract, as a pure function over a snapshot slice (BR-BPJS-015,
 * ADR-0012, implementation-roadmap §4.4 track 2). Reads nothing, calls
 * nothing, observes no clock: every branch is a function of its argument.
 *
 * This module computes; payroll orchestrates. The output is classified rows
 * rather than bare amounts because `income_class` on an employer premium is a
 * BPJS fact (BR-BPJS-011) — the rule that is easy to get wrong — and it must
 * not live in a mapping payroll maintains.
 *
 * The port adapter (`BpjsCalculatorPort`) that wraps this arrives with the
 * module in the business backbone; implementation decisions the module
 * document leaves open are recorded as A-188.
 */

export type BpjsProgram = 'kesehatan' | 'jht' | 'jp' | 'jkk' | 'jkm';
export type BpjsPayer = 'employee' | 'employer';
export type BpjsRiskClass = 'i' | 'ii' | 'iii' | 'iv' | 'v';

/** Everything the pure calculator may see. Assembled by the adapter; frozen by payroll. */
export type BpjsInput = {
  /** Drives version resolution and the age test. */
  readonly paymentDate: string;
  /** `YYYY-MM` — the credit key, BR-BPJS-010. */
  readonly taxMonth: string;
  readonly runType: 'regular' | 'thr' | 'final_settlement';
  readonly employee: {
    readonly employeeId: string;
    /** BR-BPJS-006 — the JP ceiling derives from this, never from a row. */
    readonly birthDate: string;
    /** Pipeline stage 1, unprorated — BR-BPJS-007. */
    readonly upahSebulan: string;
    /** BR-BPJS-013 — already the chargeable extra count, not a family-table size. */
    readonly additionalDependents: number;
    readonly excludedPrograms: readonly BpjsProgram[];
  };
  readonly company: {
    /** false = no registration version covers paymentDate, BR-BPJS-004. */
    readonly registered: boolean;
    readonly enabledPrograms: readonly BpjsProgram[];
    readonly jkkRiskClass: BpjsRiskClass | null;
  };
  /** Branch setting as-of, null = unconfigured (warns upstream, computes unfloored) — BR-BPJS-008. */
  readonly wageFloor: string | null;
  /** Per-program contributions already charged in the same company and tax month — BR-BPJS-010. */
  readonly mtd: readonly {
    readonly program: BpjsProgram;
    readonly base: string;
    readonly employeeCharged: string;
    readonly employerCharged: string;
  }[];
  readonly parameters: {
    /** Pinned `effective_from` — BR-BPJS-001. */
    readonly versionAsOf: string;
    readonly programs: readonly {
      readonly program: BpjsProgram;
      readonly payer: BpjsPayer;
      /** NULL only for the JKK employer row, which prices from `jkkRates`. */
      readonly rate: string | null;
      readonly baseCap: string | null;
      readonly floorApplies: boolean;
    }[];
    readonly jkkRates: readonly { readonly riskClass: string; readonly rate: string }[];
    readonly scalars: Readonly<Record<string, string>>;
  };
};

export type BpjsContribution = {
  readonly program: BpjsProgram;
  readonly payer: BpjsPayer;
  /** One of the nine seeded refs (bpjs.md §4.4) — payroll maps it mechanically. */
  readonly componentCode: string;
  readonly wageCategory: 'non_wage';
  /** BR-BPJS-011; written `non_taxable` on employee lines by convention (inert). */
  readonly incomeClass: 'regular' | 'non_taxable';
  /** The capped and floored base actually used. */
  readonly base: string;
  /** Already rounded to `contribution_rounding_unit` — BR-BPJS-014. */
  readonly amount: string;
};

export type BpjsResult = {
  readonly contributions: readonly BpjsContribution[];
  /** Employee side, post-credit — the pair BR-BPJS-012 names and BR-BPJS-017 accumulates. */
  readonly deductibleContributions: { readonly jht: string; readonly jp: string };
  readonly trace: readonly { step: string; input: string; output: string; note?: string }[];
  readonly warnings: readonly { code: string; details?: Record<string, unknown> }[];
};

/**
 * The nine seeded component refs and the statutory classification each carries.
 * `income_class` here IS BR-BPJS-011: employer Kesehatan, JKK and JKM are
 * taxable income to the employee (⚠️ VERIFY at the seed, not here — this table
 * maps codes to classes; which class is *correct* is the regulation's answer
 * and the structural suite treats it as an input fact). Employee-side entries
 * exist only for the programs that have an employee part — there is no
 * `bpjs_jkk_ee` component, so no such line can exist.
 */
const COMPONENTS: Record<
  BpjsPayer,
  Partial<Record<BpjsProgram, { code: string; incomeClass: 'regular' | 'non_taxable' }>>
> = {
  employee: {
    kesehatan: { code: 'bpjs_kesehatan_ee', incomeClass: 'non_taxable' },
    jht: { code: 'bpjs_jht_ee', incomeClass: 'non_taxable' },
    jp: { code: 'bpjs_jp_ee', incomeClass: 'non_taxable' },
  },
  employer: {
    kesehatan: { code: 'bpjs_kesehatan_er', incomeClass: 'regular' },
    jkk: { code: 'bpjs_jkk_er', incomeClass: 'regular' },
    jkm: { code: 'bpjs_jkm_er', incomeClass: 'regular' },
    jht: { code: 'bpjs_jht_er', incomeClass: 'non_taxable' },
    jp: { code: 'bpjs_jp_er', incomeClass: 'non_taxable' },
  },
};

const PROGRAM_ORDER: readonly BpjsProgram[] = ['kesehatan', 'jht', 'jp', 'jkk', 'jkm'];

/** Round to the statutory unit, half-up (BR-BPJS-014; direction A-188). */
function roundToUnit(amount: Decimal, unit: Decimal): Decimal {
  return amount.div(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(unit);
}

/**
 * `birthDate` plus `years`, on the ISO date axis, with Feb 29 clamped to
 * Feb 28 in a non-leap year (A-188). String comparison then suffices —
 * ISO dates order lexicographically — so no Date object and no clock.
 */
function addYearsIso(date: string, years: number): string {
  const [y, m, d] = date.split('-').map((part) => parseInt(part, 10)) as [number, number, number];
  const targetYear = y + years;
  const leap = targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  const day = Math.min(d, daysInMonth);
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function computeBpjs(input: BpjsInput): Result<BpjsResult, AppError> {
  const trace: { step: string; input: string; output: string; note?: string }[] = [];
  const warnings: { code: string; details?: Record<string, unknown> }[] = [];
  const zeroPair = { jht: '0.00', jp: '0.00' };

  // BR-BPJS-010: run type decides whether the month's contribution is due at
  // all — a THR run pays no monthly wage, so its floored base must never
  // charge one (§4.6's double-charge case).
  if (input.runType === 'thr') {
    trace.push({
      step: 'run_type',
      input: 'thr',
      output: 'no contributions',
      note: 'a THR run pays no monthly wage (BR-BPJS-010)',
    });
    return ok({ contributions: [], deductibleContributions: zeroPair, trace, warnings });
  }

  // BR-BPJS-004: absent tenant configuration warns; a company genuinely
  // outside BPJS is expressible and must not fail the run.
  if (!input.company.registered) {
    warnings.push({ code: 'company_not_registered' });
    trace.push({
      step: 'registration',
      input: input.paymentDate,
      output: 'no version covers the payment date',
    });
    return ok({ contributions: [], deductibleContributions: zeroPair, trace, warnings });
  }

  const scalar = (key: string): Decimal | null => {
    const value = input.parameters.scalars[key];
    return value === undefined ? null : new Decimal(value);
  };

  // BR-BPJS-014: the rounding unit is a statutory number; its absence is a
  // missing parameter version, which fails loudly (BR-BPJS-001), never a
  // default of "no rounding".
  const unit = scalar('contribution_rounding_unit');
  if (unit === null || unit.lessThanOrEqualTo(0)) {
    return fail(
      bpjsErrors.parameterMissing('bpjs_parameters.contribution_rounding_unit', input.paymentDate),
    );
  }

  const upah = new Decimal(input.employee.upahSebulan);
  const floor = input.wageFloor === null ? null : new Decimal(input.wageFloor);
  const excluded = new Set(input.employee.excludedPrograms);
  const enabled = new Set(input.company.enabledPrograms);

  const mtdCharged = (program: BpjsProgram, payer: BpjsPayer): Decimal => {
    const row = input.mtd.find((m) => m.program === program);
    if (row === undefined) return new Decimal(0);
    return new Decimal(payer === 'employee' ? row.employeeCharged : row.employerCharged);
  };

  const rateRow = (program: BpjsProgram, payer: BpjsPayer) =>
    input.parameters.programs.find((r) => r.program === program && r.payer === payer);

  const contributions: BpjsContribution[] = [];

  for (const program of PROGRAM_ORDER) {
    // §4.3's ladder, in its order: enabled → excluded → JP age → base → floor
    // → cap → rate → round → credit.
    if (!enabled.has(program)) continue;
    if (excluded.has(program)) {
      trace.push({
        step: `${program}.skipped`,
        input: 'exclusion row',
        output: 'no contribution',
        note: 'BR-BPJS-005',
      });
      continue;
    }
    if (program === 'jp') {
      const ceiling = scalar('jp_max_age_years');
      if (ceiling === null) {
        return fail(
          bpjsErrors.parameterMissing('bpjs_parameters.jp_max_age_years', input.paymentDate),
        );
      }
      // BR-BPJS-006: attained on the payment date — on or after the birthday
      // that reaches the ceiling, contributions stop (A-188). Derived every
      // run; a birthday is not a data-entry event.
      const threshold = addYearsIso(input.employee.birthDate, ceiling.toNumber());
      if (input.paymentDate >= threshold) {
        trace.push({
          step: 'jp.skipped',
          input: `birthDate ${input.employee.birthDate}`,
          output: `age ceiling ${ceiling.toFixed(0)} attained ${threshold}`,
          note: 'BR-BPJS-006',
        });
        continue;
      }
    }

    for (const payer of ['employee', 'employer'] as const) {
      const component = COMPONENTS[payer][program];
      if (component === undefined) continue; // no such line can exist (no seeded ref)

      const row = rateRow(program, payer);
      if (row === undefined) {
        return fail(
          bpjsErrors.parameterMissing(`bpjs_program_rates.${program}.${payer}`, input.paymentDate),
        );
      }

      // BR-BPJS-002: the JKK employer rate is a function of the company's
      // risk class; every other row carries its own.
      let rate: Decimal;
      if (row.rate !== null) {
        rate = new Decimal(row.rate);
      } else {
        const riskClass = input.company.jkkRiskClass;
        if (riskClass === null) {
          // Impossible to persist (CHECK constraint); exists for migrated data.
          warnings.push({ code: 'jkk_risk_class_missing' });
          trace.push({ step: 'jkk.skipped', input: 'no risk class', output: 'no contribution' });
          continue;
        }
        const riskRow = input.parameters.jkkRates.find((r) => r.riskClass === riskClass);
        if (riskRow === undefined) {
          return fail(
            bpjsErrors.parameterMissing(`bpjs_jkk_risk_rates.${riskClass}`, input.paymentDate),
          );
        }
        rate = new Decimal(riskRow.rate);
      }

      // BR-BPJS-008 / BR-BPJS-009: floor where the statute applies it, then
      // cap where one exists — per program row, so Kesehatan and JP can cap
      // at different amounts in the same run.
      let base = upah;
      const notes: string[] = [];
      if (row.floorApplies && floor !== null && floor.greaterThan(base)) {
        base = floor;
        notes.push('floored to branch minimum');
      }
      if (row.baseCap !== null) {
        const cap = new Decimal(row.baseCap);
        if (cap.lessThan(base)) {
          base = cap;
          notes.push('capped');
        }
      }

      const due = roundToUnit(base.times(rate), unit);
      trace.push({
        step: `${program}.${payer}`,
        input: `${base.toFixed(2)} × ${rate.toFixed(4)}`,
        output: due.toFixed(2),
        ...(notes.length > 0 ? { note: notes.join(', ') } : {}),
      });

      // This (program, payer) bucket's dues: the main line, plus the dependent
      // surcharge on the Kesehatan employee side (BR-BPJS-013 — each chargeable
      // additional dependent adds a percentage of the Kesehatan base).
      const dues: { code: string; incomeClass: 'regular' | 'non_taxable'; due: Decimal }[] = [
        { code: component.code, incomeClass: component.incomeClass, due },
      ];
      if (
        program === 'kesehatan' &&
        payer === 'employee' &&
        input.employee.additionalDependents > 0
      ) {
        const pct = scalar('kesehatan_extra_dependent_pct');
        if (pct === null) {
          return fail(
            bpjsErrors.parameterMissing(
              'bpjs_parameters.kesehatan_extra_dependent_pct',
              input.paymentDate,
            ),
          );
        }
        const surcharge = roundToUnit(
          base.times(pct).times(input.employee.additionalDependents),
          unit,
        );
        trace.push({
          step: 'kesehatan.dependents',
          input: `${base.toFixed(2)} × ${pct.toFixed(4)} × ${input.employee.additionalDependents}`,
          output: surcharge.toFixed(2),
          note: 'BR-BPJS-013',
        });
        if (!surcharge.isZero()) {
          dues.push({
            code: 'bpjs_kesehatan_dependents_ee',
            incomeClass: 'non_taxable',
            due: surcharge,
          });
        }
      }

      // BR-BPJS-010: charge `max(0, month due − already charged)`, per program
      // and payer. `mtd` carries one figure per (program, payer) — a prior
      // run's surcharge is inside it — so the credit applies to the bucket as
      // a whole and allocates to the main line first, the surcharge after
      // (A-188). Crediting only the main line would re-charge a settlement's
      // surcharge in full.
      const charged = mtdCharged(program, payer);
      const bucketDue = dues.reduce((sum, line) => sum.plus(line.due), new Decimal(0));
      let remaining = bucketDue;
      if (charged.greaterThan(0)) {
        remaining = Decimal.max(0, bucketDue.minus(charged));
        trace.push({
          step: `${program}.${payer}.credit`,
          input: `${bucketDue.toFixed(2)} − ${charged.toFixed(2)}`,
          output: remaining.toFixed(2),
          note: 'BR-BPJS-010',
        });
      }
      for (const line of dues) {
        const amount = Decimal.min(line.due, remaining);
        remaining = remaining.minus(amount);
        if (amount.isZero()) continue; // a zero line is noise; the trace records why (A-188)
        contributions.push({
          program,
          payer,
          componentCode: line.code,
          wageCategory: 'non_wage',
          incomeClass: line.incomeClass,
          base: base.toFixed(2),
          amount: amount.toFixed(2),
        });
      }
    }
  }

  // BR-BPJS-012: the pair the annual PPh 21 path deducts — exactly the JHT
  // and JP employee lines, post-credit, and never the Kesehatan part.
  const emitted = (code: string): string =>
    contributions.find((c) => c.componentCode === code)?.amount ?? '0.00';

  return ok({
    contributions,
    deductibleContributions: { jht: emitted('bpjs_jht_ee'), jp: emitted('bpjs_jp_ee') },
    trace,
    warnings,
  });
}
