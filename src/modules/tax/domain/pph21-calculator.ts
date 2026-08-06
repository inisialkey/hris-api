import Decimal from 'decimal.js';

import { AppError } from '../../../shared/app-error';
import { fail, ok, Result } from '../../../shared/result';
import { taxErrors } from './tax.errors';

/**
 * The PPh 21 withholding calculator — tax-pph21.md §4.4's contract and §4.6's
 * two paths, as a pure function over a snapshot slice (BR-TAX-017, ADR-0012,
 * implementation-roadmap §4.4 track 2). Reads nothing, calls nothing, observes
 * no clock; `path` arrives derived (BR-TAX-008), never decided here.
 *
 * Payroll decides what was earned; this decides what is withheld from it.
 * The port adapter (`Pph21CalculatorPort`) that wraps this arrives with the
 * module; implementation decisions the module document leaves open are
 * recorded as A-189.
 */

export type Pph21IncomeClass = 'regular' | 'irregular' | 'non_taxable' | 'final';

export type Pph21Band = {
  readonly from: string;
  readonly to: string | null; // half-open [from, to); NULL = unbounded
  readonly rate: string;
};

/** Everything the pure calculator may see. Assembled by the adapter; frozen by payroll. */
export type Pph21Input = {
  readonly taxYear: number;
  /** Drives version resolution and the annual trigger — upstream, not here. */
  readonly paymentDate: string;
  /** Derived by payroll: December payment date or any final_settlement run (BR-TAX-008). */
  readonly path: 'monthly' | 'annual';
  readonly employee: {
    readonly ptkpStatus: string; // pinned, BR-TAX-005
    readonly terCategory: 'a' | 'b' | 'c';
    readonly hasNpwp: boolean; // per run, BR-TAX-009
    readonly method: 'gross' | 'gross_up';
    readonly monthsEmployedInYear: number;
  };
  readonly lines: readonly {
    readonly componentCode: string;
    readonly incomeClass: Pph21IncomeClass;
    readonly amount: string;
  }[];
  /** Employee side, whole year — annual path only; supplied by bpjs (BR-BPJS-012). */
  readonly deductibleContributions: { readonly jht: string; readonly jp: string };
  /** Same company and tax month, runs at approved or later (BR-TAX-007). */
  readonly mtd: { readonly bruto: string; readonly pph21Withheld: string };
  readonly ytd: {
    readonly gross: string;
    readonly taxableRegular: string;
    readonly taxableIrregular: string;
    readonly pph21Withheld: string;
    readonly finalIncome: string;
    readonly pph21Final: string;
  };
  /** Annual path only, never the monthly rate (BR-TAX-014). */
  readonly previousEmployer?: {
    readonly neto: string;
    readonly pph21: string;
    readonly months: number;
  };
  readonly parameters: {
    readonly versionAsOf: string; // pinned effective_from
    readonly ptkpAnnualAmount: string;
    /** Already filtered to the employee's TER category by the adapter. */
    readonly terBands: readonly Pph21Band[];
    readonly progressiveBands: readonly Pph21Band[];
    readonly severanceBands: readonly Pph21Band[];
    readonly scalars: Readonly<Record<string, string>>;
  };
};

export type Pph21Result = {
  /** Rounded; may be negative on the annual path — then a refund line. */
  readonly withholding: string;
  /** Gross-up only (BR-TAX-010): equals the withholding, or 0 against a refund. */
  readonly taxAllowance: string | null;
  /** Severance (BR-TAX-011): priced on its own bands, outside TER and annual. */
  readonly finalTax: string;
  /** As actually used, including any allowance. */
  readonly taxableRegular: string;
  readonly taxableIrregular: string;
  readonly trace: readonly { step: string; input: string; output: string; note?: string }[];
  readonly warnings: readonly { code: string; details?: Record<string, unknown> }[];
};

const ZERO = new Decimal(0);

/** Flat-rate band lookup: the band whose half-open [from, to) contains `amount`. */
function bandFor(bands: readonly Pph21Band[], amount: Decimal): Pph21Band | null {
  for (const band of bands) {
    const from = new Decimal(band.from);
    const to = band.to === null ? null : new Decimal(band.to);
    if (amount.greaterThanOrEqualTo(from) && (to === null || amount.lessThan(to))) return band;
  }
  return null;
}

/** Marginal walk: Σ per layer, rate × the slice of `amount` inside [from, to). */
function marginalTax(bands: readonly Pph21Band[], amount: Decimal): Decimal {
  let tax = ZERO;
  for (const band of bands) {
    const from = new Decimal(band.from);
    const to = band.to === null ? null : new Decimal(band.to);
    if (amount.lessThanOrEqualTo(from)) continue;
    const upper = to === null ? amount : Decimal.min(amount, to);
    tax = tax.plus(upper.minus(from).times(band.rate));
  }
  return tax;
}

/** Round to a statutory unit. PKP rounds down; PPh 21 rounds half-up (A-189). */
function roundToUnit(amount: Decimal, unit: Decimal, mode: Decimal.Rounding): Decimal {
  return amount.div(unit).toDecimalPlaces(0, mode).times(unit);
}

export function computePph21(input: Pph21Input): Result<Pph21Result, AppError> {
  const trace: { step: string; input: string; output: string; note?: string }[] = [];
  const p = input.parameters;

  const scalar = (key: string): Result<Decimal, AppError> => {
    const value = p.scalars[key];
    if (value === undefined) {
      return fail(taxErrors.parameterMissing(`tax_parameters.${key}`, input.paymentDate));
    }
    return ok(new Decimal(value));
  };
  const pph21Unit = scalar('pph21_rounding_unit');
  if (!pph21Unit.ok) return pph21Unit;
  const surchargePct = scalar('non_npwp_surcharge_pct');
  if (!surchargePct.ok) return surchargePct;
  // BR-TAX-009: one knob — a surcharge multiplier of 1 when the employee has
  // an NPWP, or the rule has been retired by setting the percentage to 0.
  const surchargeFactor = input.employee.hasNpwp ? new Decimal(1) : surchargePct.value.plus(1);

  // ---- Base assembly: sum lines by income class (BR-TAX-013, BR-TAX-011) ----
  const sumClass = (cls: Pph21IncomeClass): Decimal =>
    input.lines.filter((l) => l.incomeClass === cls).reduce((sum, l) => sum.plus(l.amount), ZERO);
  const regular = sumClass('regular');
  const irregular = sumClass('irregular');
  const finalIncome = sumClass('final');
  const runBruto = regular.plus(irregular);
  trace.push({
    step: 'bruto',
    input: `regular ${regular.toFixed(2)} + irregular ${irregular.toFixed(2)}`,
    output: runBruto.toFixed(2),
    note: 'non_taxable excluded; final priced on its own bands (BR-TAX-011)',
  });

  // ---- Severance / final (BR-TAX-011): cumulative over the year's final
  // income, outside TER and outside the annual path, on either path ----------
  let finalTax = ZERO;
  if (finalIncome.greaterThan(0)) {
    if (p.severanceBands.length === 0) {
      return fail(taxErrors.parameterMissing('tax_severance_brackets', input.paymentDate));
    }
    const cumulativeFinal = new Decimal(input.ytd.finalIncome).plus(finalIncome);
    const cumulativeTax = marginalTax(p.severanceBands, cumulativeFinal);
    // The final tariff is its own regime; the non-NPWP surcharge does not
    // apply to it (A-189).
    finalTax = roundToUnit(
      Decimal.max(0, cumulativeTax.minus(input.ytd.pph21Final)),
      pph21Unit.value,
      Decimal.ROUND_HALF_UP,
    );
    trace.push({
      step: 'final.tax',
      input: `bands over cumulative ${cumulativeFinal.toFixed(2)} − ${new Decimal(input.ytd.pph21Final).toFixed(2)} already withheld`,
      output: finalTax.toFixed(2),
      note: 'BR-TAX-011 — excluded from TER and the annual recalculation',
    });
  }

  const finish = (
    withholdingRaw: Decimal,
    allowance: Decimal | null,
  ): Result<Pph21Result, AppError> => {
    const withholding = roundToUnit(withholdingRaw, pph21Unit.value, Decimal.ROUND_HALF_UP);
    trace.push({
      step: 'rounding',
      input: withholdingRaw.toFixed(2),
      output: withholding.toFixed(2),
    });
    return ok({
      withholding: withholding.toFixed(2),
      taxAllowance: allowance === null ? null : allowance.toFixed(2),
      finalTax: finalTax.toFixed(2),
      taxableRegular: regular.plus(allowance ?? ZERO).toFixed(2),
      taxableIrregular: irregular.toFixed(2),
      trace,
      warnings: [],
    });
  };

  if (input.path === 'monthly') {
    // ---- Monthly: TER over the month's cumulative bruto (BR-TAX-006) -------
    if (p.terBands.length === 0) {
      return fail(
        taxErrors.parameterMissing(
          `tax_ter_rates.${input.employee.terCategory}`,
          input.paymentDate,
        ),
      );
    }
    const mtdBruto = new Decimal(input.mtd.bruto);
    const mtdWithheld = new Decimal(input.mtd.pph21Withheld);

    const monthlyWithholding = (allowance: Decimal): Result<Decimal, AppError> => {
      const cumulative = mtdBruto.plus(runBruto).plus(allowance);
      const band = bandFor(p.terBands, cumulative);
      if (band === null) {
        return fail(
          taxErrors.parameterMissing(
            `tax_ter_rates.${input.employee.terCategory}`,
            input.paymentDate,
          ),
        );
      }
      trace.push({
        step: 'ter.band',
        input: `cumulative bruto ${cumulative.toFixed(2)}`,
        output: `rate ${band.rate}`,
        note: 'TER is a rate on the month’s total bruto (BR-TAX-006)',
      });
      // The monthly figure floors at zero: refunds are the annual path's job
      // (BR-TAX-009 — recovering a surcharge monthly would refund it twice).
      const raw = Decimal.max(
        0,
        cumulative.times(band.rate).minus(mtdWithheld).times(surchargeFactor),
      );
      if (!surchargeFactor.equals(1)) {
        trace.push({
          step: 'surcharge',
          input: `× ${surchargeFactor.toFixed(4)}`,
          output: raw.toFixed(2),
          note: 'BR-TAX-009',
        });
      }
      return ok(raw);
    };

    if (input.employee.method === 'gross') {
      const raw = monthlyWithholding(ZERO);
      if (!raw.ok) return raw;
      return finish(raw.value, null);
    }

    // Gross-up (BR-TAX-010): the allowance equals the withholding, solved in
    // one call. Closed form per TER band — A = e(r·cum − mtdW)/(1 − e·r) —
    // walking bands until the allowance lands in the band that priced it,
    // since the allowance itself is taxable bruto.
    for (const band of p.terBands) {
      const r = new Decimal(band.rate).times(surchargeFactor);
      if (r.greaterThanOrEqualTo(1)) {
        return fail(taxErrors.grossUpUnsolvable(band.rate, surchargeFactor.toFixed(4)));
      }
      const cum = mtdBruto.plus(runBruto);
      const allowanceRaw = Decimal.max(
        0,
        cum
          .times(band.rate)
          .minus(new Decimal(input.mtd.pph21Withheld))
          .times(surchargeFactor)
          .div(new Decimal(1).minus(r)),
      );
      const landed = cum.plus(allowanceRaw);
      const from = new Decimal(band.from);
      const to = band.to === null ? null : new Decimal(band.to);
      if (landed.greaterThanOrEqualTo(from) && (to === null || landed.lessThan(to))) {
        const allowance = roundToUnit(allowanceRaw, pph21Unit.value, Decimal.ROUND_HALF_UP);
        trace.push({
          step: 'grossup.allowance',
          input: `rate ${band.rate} over ${cum.toFixed(2)}`,
          output: allowance.toFixed(2),
          note: 'allowance equals the withholding; take-home unchanged (BR-TAX-010)',
        });
        // The pair is returned already equal — the rounded allowance IS the
        // withholding line (A-189), so the payslip foots exactly.
        return ok({
          withholding: allowance.toFixed(2),
          taxAllowance: allowance.toFixed(2),
          finalTax: finalTax.toFixed(2),
          taxableRegular: regular.plus(allowance).toFixed(2),
          taxableIrregular: irregular.toFixed(2),
          trace,
          warnings: [],
        });
      }
    }
    return fail(
      taxErrors.parameterMissing(`tax_ter_rates.${input.employee.terCategory}`, input.paymentDate),
    );
  }

  // ---- Annual: December or final settlement (BR-TAX-008) -------------------
  if (p.progressiveBands.length === 0) {
    return fail(taxErrors.parameterMissing('tax_brackets', input.paymentDate));
  }
  const bjPct = scalar('biaya_jabatan_pct');
  if (!bjPct.ok) return bjPct;
  const bjMonthlyCap = scalar('biaya_jabatan_monthly_cap');
  if (!bjMonthlyCap.ok) return bjMonthlyCap;
  const bjAnnualCap = scalar('biaya_jabatan_annual_cap');
  if (!bjAnnualCap.ok) return bjAnnualCap;
  const pkpUnit = scalar('pkp_rounding_unit');
  if (!pkpUnit.ok) return pkpUnit;

  const ptkp = new Decimal(p.ptkpAnnualAmount);
  const months = Math.min(Math.max(input.employee.monthsEmployedInYear, 1), 12);
  const deductible = new Decimal(input.deductibleContributions.jht).plus(
    input.deductibleContributions.jp,
  );
  // The year's withholding so far is the closed runs' ledger plus the same
  // month's approved-but-unclosed siblings — the MTD slice (A-189).
  const withheldSoFar = new Decimal(input.ytd.pph21Withheld).plus(input.mtd.pph21Withheld);
  const prevNeto =
    input.previousEmployer === undefined ? ZERO : new Decimal(input.previousEmployer.neto);
  const prevPph21 =
    input.previousEmployer === undefined ? ZERO : new Decimal(input.previousEmployer.pph21);

  // W(A): the annual remainder given a tax allowance A joining this run's
  // gross. Fixed-point target for gross-up; called once with A = 0 for gross.
  const annualRemainder = (allowance: Decimal): Decimal => {
    const annualGross = new Decimal(input.ytd.gross)
      .plus(input.mtd.bruto)
      .plus(runBruto)
      .plus(allowance);
    // biaya jabatan: pct of gross, under both the monthly cap × months
    // employed and the annual cap (composition A-189; values ⚠️ VERIFY via
    // the seed, not here).
    const biayaJabatan = Decimal.min(
      annualGross.times(bjPct.value),
      bjMonthlyCap.value.times(months),
      bjAnnualCap.value,
    );
    const neto = annualGross.minus(biayaJabatan).minus(deductible).plus(prevNeto);
    // PKP rounds DOWN to its unit — the one direction BR-TAX-016 fixes.
    const pkp = roundToUnit(Decimal.max(0, neto.minus(ptkp)), pkpUnit.value, Decimal.ROUND_DOWN);
    const annualTax = marginalTax(p.progressiveBands, pkp);
    return annualTax.minus(prevPph21).minus(withheldSoFar);
  };

  if (input.employee.method === 'gross') {
    const remainder = annualRemainder(ZERO);
    // The surcharge multiplies a positive withholding only — never a refund
    // (BR-TAX-009; A-189).
    const raw = remainder.greaterThan(0) ? remainder.times(surchargeFactor) : remainder;
    trace.push({
      step: 'annual.remainder',
      input: `credit ${withheldSoFar.toFixed(2)} + prior ${prevPph21.toFixed(2)}`,
      output: raw.toFixed(2),
      note: raw.isNegative() ? 'negative — a refund line (BR-TAX-008)' : undefined,
    });
    return finish(raw, null);
  }

  // Annual gross-up: A = W(A), solved by fixed-point iteration — the marginal
  // rate is under 1, so the map contracts; PKP's floor-rounding makes a
  // closed form per layer messier than it is worth (A-189). Against a refund
  // the allowance clamps to zero (§9) and the refund reaches the employee as
  // the reduced deduction.
  let allowance = ZERO;
  for (let i = 0; i < 50; i += 1) {
    const next = Decimal.max(0, annualRemainder(allowance).times(surchargeFactor));
    if (next.minus(allowance).abs().lessThan(1)) {
      allowance = next;
      break;
    }
    allowance = next;
  }
  allowance = roundToUnit(allowance, pph21Unit.value, Decimal.ROUND_HALF_UP);
  const remainder = annualRemainder(allowance);
  const raw = remainder.greaterThan(0) ? remainder.times(surchargeFactor) : remainder;
  trace.push({
    step: 'grossup.allowance',
    input: 'fixed point of A = W(A)',
    output: allowance.toFixed(2),
    note: 'annual path solves per bracket layer via iteration (A-189)',
  });
  return finish(raw, allowance);
}
