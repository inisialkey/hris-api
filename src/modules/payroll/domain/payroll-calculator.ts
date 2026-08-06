import Decimal from 'decimal.js';

import { computeBpjs, type BpjsInput, type BpjsProgram, type BpjsRiskClass } from '../../bpjs';
import { computePph21, type Pph21Input } from '../../tax';
import { AppError } from '../../../shared/app-error';
import { fail, ok, Result } from '../../../shared/result';
import { payrollErrors } from './payroll.errors';

/**
 * The payroll calculation pipeline — payroll.md §4.5's eight stages over one
 * employee's snapshot slice, as a pure function (BR-PAY-009, ADR-0012,
 * implementation-roadmap §4.4 track 2). Order is fixed in code; each stage
 * rounds before the next reads it.
 *
 * Stages 4 and 6 are the sibling calculators, invoked through their facades —
 * the two never call each other, and pipeline order here is the whole of the
 * coupling (tax-pph21.md §13). Everything BPJS contributes to the tax answer
 * travels through this function's own line array.
 *
 * Deliberately absent from track 2's slice, arriving with the module:
 * sick-leave wage scaling (BR-PAY-014), retro deltas, `rate_of_base`
 * resolution (the adapter resolves component amounts), and the run-level
 * aggregates. Implementation decisions the module document leaves open are
 * recorded as A-190.
 */

export type PayrollLineKind = 'earning' | 'deduction' | 'employer_cost';
export type PayrollWageCategory = 'basic' | 'fixed_allowance' | 'variable_allowance' | 'non_wage';
export type PayrollIncomeClass = 'regular' | 'irregular' | 'non_taxable' | 'final';

/** One resolved component: the adapter has already priced `source` into `amount`. */
export type PayrollComponentInput = {
  readonly code: string;
  readonly kind: 'earning' | 'deduction';
  readonly wageCategory: PayrollWageCategory;
  readonly incomeClass: PayrollIncomeClass;
  readonly amount: string;
  readonly proratable: boolean;
};

export type PayrollLine = {
  readonly code: string;
  readonly kind: PayrollLineKind;
  readonly wageCategory: PayrollWageCategory;
  readonly incomeClass: PayrollIncomeClass;
  /** Multiplier-hours on the overtime line (payroll.md §4.5 stage 2), else null. */
  readonly quantity: string | null;
  /** Already rounded — the net is a sum of rounded lines (BR-PAY-012). */
  readonly amount: string;
};

/** Everything the pure pipeline may see. Assembled by the adapter; frozen at snapshot. */
export type PayrollEmployeeInput = {
  readonly runType: 'regular' | 'thr' | 'final_settlement';
  readonly paymentDate: string;
  readonly taxMonth: string; // YYYY-MM
  readonly components: readonly PayrollComponentInput[];
  /** `OvertimeQueryPort.summaryFor`'s one number (overtime.md §4.3); null = none. */
  readonly overtime: { readonly multiplierHours: string } | null;
  /** Null = no proration this run (BR-PAY-013). */
  readonly proration: {
    readonly basis: 'calendar_days' | 'working_days' | 'fixed_divisor';
    readonly daysInPeriod: number;
    readonly daysPayable: number;
    readonly fixedDailyDivisor: number | null;
  } | null;
  /** THR runs only (BR-PAY-015). */
  readonly thr: { readonly serviceMonths: number } | null;
  readonly employee: {
    readonly employeeId: string;
    readonly birthDate: string;
    readonly additionalDependents: number;
    readonly excludedPrograms: readonly BpjsProgram[];
    readonly ptkpStatus: string;
    readonly terCategory: 'a' | 'b' | 'c';
    readonly hasNpwp: boolean;
    readonly taxMethod: 'gross' | 'gross_up';
    readonly monthsEmployedInYear: number;
  };
  readonly company: {
    readonly bpjsRegistered: boolean;
    readonly enabledPrograms: readonly BpjsProgram[];
    readonly jkkRiskClass: BpjsRiskClass | null;
  };
  readonly wageFloor: string | null;
  readonly bpjsMtd: BpjsInput['mtd'];
  readonly taxMtd: Pph21Input['mtd'];
  readonly ytd: Pph21Input['ytd'];
  /** Whole-year employee JHT+JP for the annual path (BR-TAX-008); adapter-assembled. */
  readonly annualDeductibleContributions: { readonly jht: string; readonly jp: string };
  readonly previousEmployer?: Pph21Input['previousEmployer'];
  readonly parameters: {
    readonly payroll: { readonly scalars: Readonly<Record<string, string>> };
    readonly bpjs: BpjsInput['parameters'];
    readonly tax: Pph21Input['parameters'];
  };
};

export type PayrollEmployeeResult = {
  readonly lines: readonly PayrollLine[];
  readonly bases: {
    readonly upahSebulan: string; // Σ basic + Σ fixed_allowance (BR-PAY-003)
    readonly totalWage: string; // + Σ variable_allowance
    readonly overtimeHourlyBasis: string | null; // BR-PAY-004
    readonly prorationFactor: string; // "1.000000" when no proration
  };
  readonly taxable: { readonly regular: string; readonly irregular: string };
  /** Σ earning − Σ deduction over rounded lines; employer_cost outside both (BR-PAY-012). */
  readonly netPay: string;
  readonly trace: readonly { step: string; input: string; output: string; note?: string }[];
  readonly warnings: readonly { code: string; details?: Record<string, unknown> }[];
};

const ZERO = new Decimal(0);

export function computePayrollEmployee(
  input: PayrollEmployeeInput,
): Result<PayrollEmployeeResult, AppError> {
  const trace: { step: string; input: string; output: string; note?: string }[] = [];
  const warnings: { code: string; details?: Record<string, unknown> }[] = [];
  const lines: PayrollLine[] = [];

  const scalar = (key: string): Result<Decimal, AppError> => {
    const value = input.parameters.payroll.scalars[key];
    if (value === undefined) {
      return fail(payrollErrors.parameterMissing(`payroll.${key}`, input.paymentDate));
    }
    return ok(new Decimal(value));
  };
  const unitResult = scalar('line_rounding_unit');
  if (!unitResult.ok) return unitResult;
  const unit = unitResult.value;
  if (unit.lessThanOrEqualTo(0)) {
    return fail(payrollErrors.parameterMissing('payroll.line_rounding_unit', input.paymentDate));
  }
  /** Stage rounding, half-up at the payroll line unit (BR-PAY-012; A-190). */
  const round = (amount: Decimal): Decimal =>
    amount.div(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(unit);

  // ---- Stage 1 — gross earnings and the statutory bases (BR-PAY-003) -------
  // Bases sum the *unprorated* amounts: upah sebulan is a wage, not a payment,
  // and stage 4 must read it unprorated (BR-PAY-027).
  const sumCategory = (category: PayrollWageCategory): Decimal =>
    input.components
      .filter((c) => c.kind === 'earning' && c.wageCategory === category)
      .reduce((sum, c) => sum.plus(c.amount), ZERO);
  const upahSebulan = sumCategory('basic').plus(sumCategory('fixed_allowance'));
  const totalWage = upahSebulan.plus(sumCategory('variable_allowance'));
  trace.push({
    step: 'bases',
    input: `basic+fixed ${upahSebulan.toFixed(2)}, +variable ${totalWage.toFixed(2)}`,
    output: upahSebulan.toFixed(2),
    note: 'upah sebulan = Σ basic + Σ fixed_allowance (BR-PAY-003), unprorated',
  });

  // ---- Stage 3's factor, computed first so stages 1–2 can apply it to
  // proratable lines as they emit (the stage order is about what each stage
  // *reads* — proration never feeds the bases above) ------------------------
  let factor = new Decimal(1);
  if (input.proration !== null) {
    const { basis, daysInPeriod, daysPayable, fixedDailyDivisor } = input.proration;
    const divisor = basis === 'fixed_divisor' ? fixedDailyDivisor : daysInPeriod;
    if (divisor === null || divisor <= 0 || daysPayable < 0) {
      return fail(payrollErrors.parameterMissing('payroll.proration_basis', input.paymentDate));
    }
    // A factor never exceeds 1: a fixed divisor smaller than the days worked
    // caps at the full amount (P3 — prorated ∈ [0, full]).
    factor = Decimal.min(1, new Decimal(daysPayable).div(divisor));
    trace.push({
      step: 'proration.factor',
      input: `${daysPayable}/${divisor} (${basis})`,
      output: factor.toFixed(6),
      note: 'BR-PAY-013',
    });
  }

  if (input.runType === 'thr') {
    // ---- THR (BR-PAY-015): entitlement over the THR base, no attendance,
    // no proration machinery, no component lines ----------------------------
    if (input.thr === null) {
      return fail(payrollErrors.parameterMissing('thr.serviceMonths', input.paymentDate));
    }
    const months = input.thr.serviceMonths;
    if (months < 1) {
      warnings.push({ code: 'thr_not_eligible', details: { serviceMonths: months } });
      trace.push({
        step: 'thr',
        input: `${months} service months`,
        output: '0.00',
        note: 'below one month (BR-PAY-015)',
      });
    } else {
      const entitlement = round(months >= 12 ? upahSebulan : upahSebulan.times(months).div(12));
      trace.push({
        step: 'thr',
        input: months >= 12 ? 'full upah sebulan' : `${months}/12 × ${upahSebulan.toFixed(2)}`,
        output: entitlement.toFixed(2),
        note: 'BR-PAY-015',
      });
      lines.push({
        code: 'thr',
        kind: 'earning',
        wageCategory: 'non_wage',
        incomeClass: 'irregular',
        quantity: null,
        amount: entitlement.toFixed(2),
      });
    }
  } else {
    // Ordinary earning lines, prorated where the component says so.
    for (const component of input.components.filter((c) => c.kind === 'earning')) {
      const raw = new Decimal(component.amount);
      const amount = round(component.proratable ? raw.times(factor) : raw);
      lines.push({
        code: component.code,
        kind: 'earning',
        wageCategory: component.wageCategory,
        incomeClass: component.incomeClass,
        quantity: null,
        amount: amount.toFixed(2),
      });
    }
  }

  // ---- Stage 2 — overtime: multiplier-hours × the hourly basis ------------
  let overtimeHourlyBasis: Decimal | null = null;
  if (input.overtime !== null && input.runType !== 'thr') {
    const divisor = scalar('overtime_divisor');
    if (!divisor.ok) return divisor;
    const floorPct = scalar('overtime_basis_floor_pct');
    if (!floorPct.ok) return floorPct;
    // BR-PAY-004: where basic + fixed allowance is under the floor share of
    // total wage, the basis computes from the floor instead — the comparison
    // *between* two bases no per-component flag can express (§4.5).
    overtimeHourlyBasis = Decimal.max(upahSebulan, totalWage.times(floorPct.value)).div(
      divisor.value,
    );
    const multiplierHours = new Decimal(input.overtime.multiplierHours);
    const amount = round(multiplierHours.times(overtimeHourlyBasis));
    trace.push({
      step: 'overtime',
      input: `${multiplierHours.toFixed(4)} mh × basis ${overtimeHourlyBasis.toFixed(2)}`,
      output: amount.toFixed(2),
      note: 'BR-PAY-004',
    });
    if (!amount.isZero()) {
      lines.push({
        code: 'overtime',
        kind: 'earning',
        wageCategory: 'non_wage', // never feeds its own basis (A-190)
        incomeClass: 'regular',
        quantity: multiplierHours.toFixed(4),
        amount: amount.toFixed(2),
      });
    }
  }

  // ---- Stage 4 — BPJS over the stage-1 unprorated wage (BR-PAY-027) -------
  const bpjs = computeBpjs({
    paymentDate: input.paymentDate,
    taxMonth: input.taxMonth,
    runType: input.runType,
    employee: {
      employeeId: input.employee.employeeId,
      birthDate: input.employee.birthDate,
      upahSebulan: upahSebulan.toFixed(2),
      additionalDependents: input.employee.additionalDependents,
      excludedPrograms: input.employee.excludedPrograms,
    },
    company: {
      registered: input.company.bpjsRegistered,
      enabledPrograms: input.company.enabledPrograms,
      jkkRiskClass: input.company.jkkRiskClass,
    },
    wageFloor: input.wageFloor,
    mtd: input.bpjsMtd,
    parameters: input.parameters.bpjs,
  });
  if (!bpjs.ok) return bpjs;
  for (const contribution of bpjs.value.contributions) {
    // Mechanical mapping, knowing no BPJS semantics (bpjs.md §4.4): the
    // employee side deducts, the employer side is the third line kind.
    lines.push({
      code: contribution.componentCode,
      kind: contribution.payer === 'employee' ? 'deduction' : 'employer_cost',
      wageCategory: contribution.wageCategory,
      incomeClass: contribution.incomeClass,
      quantity: null,
      amount: contribution.amount,
    });
  }
  warnings.push(...bpjs.value.warnings);

  // ---- Stage 5 — taxable assembly (BR-PAY-026): earning and employer_cost
  // lines by income class; deduction lines never ----------------------------
  const taxLines = lines.filter((l) => l.kind !== 'deduction');

  // ---- Stage 6 — PPh 21. The path derives from the run itself: a December
  // payment date or any final settlement (BR-TAX-008) -----------------------
  const path =
    input.runType === 'final_settlement' || input.paymentDate.slice(5, 7) === '12'
      ? 'annual'
      : 'monthly';
  const tax = computePph21({
    taxYear: parseInt(input.paymentDate.slice(0, 4), 10),
    paymentDate: input.paymentDate,
    path,
    employee: {
      ptkpStatus: input.employee.ptkpStatus,
      terCategory: input.employee.terCategory,
      hasNpwp: input.employee.hasNpwp,
      method: input.employee.taxMethod,
      monthsEmployedInYear: input.employee.monthsEmployedInYear,
    },
    lines: taxLines.map((l) => ({
      componentCode: l.code,
      incomeClass: l.incomeClass,
      amount: l.amount,
    })),
    deductibleContributions:
      path === 'annual' ? input.annualDeductibleContributions : bpjs.value.deductibleContributions,
    mtd: input.taxMtd,
    ytd: input.ytd,
    ...(input.previousEmployer !== undefined ? { previousEmployer: input.previousEmployer } : {}),
    parameters: input.parameters.tax,
  });
  if (!tax.ok) return tax;
  if (tax.value.taxAllowance !== null && new Decimal(tax.value.taxAllowance).greaterThan(0)) {
    // BR-TAX-010 / A-034: the allowance is non_wage so it moves no wage base
    // — classifying it variable_allowance would raise the overtime floor,
    // the overtime pay, the tax, and the allowance: a cycle.
    lines.push({
      code: 'tunjangan_pajak',
      kind: 'earning',
      wageCategory: 'non_wage',
      incomeClass: 'regular',
      quantity: null,
      amount: tax.value.taxAllowance,
    });
  }
  if (!new Decimal(tax.value.withholding).isZero()) {
    lines.push({
      code: 'pph21',
      kind: 'deduction',
      wageCategory: 'non_wage',
      incomeClass: 'non_taxable', // inert on deduction lines (BR-PAY-002)
      quantity: null,
      amount: tax.value.withholding,
    });
  }
  if (!new Decimal(tax.value.finalTax).isZero()) {
    lines.push({
      code: 'pph21_final',
      kind: 'deduction',
      wageCategory: 'non_wage',
      incomeClass: 'non_taxable',
      quantity: null,
      amount: tax.value.finalTax,
    });
  }

  // ---- Stage 7 — other deductions, prorated where the component says so ----
  if (input.runType !== 'thr') {
    for (const component of input.components.filter((c) => c.kind === 'deduction')) {
      const raw = new Decimal(component.amount);
      const amount = round(component.proratable ? raw.times(factor) : raw);
      if (amount.isZero()) continue;
      lines.push({
        code: component.code,
        kind: 'deduction',
        wageCategory: component.wageCategory,
        incomeClass: 'non_taxable', // inert on deduction lines (BR-PAY-002)
        quantity: null,
        amount: amount.toFixed(2),
      });
    }
  }

  // ---- Stage 8 — net over rounded lines; employer_cost outside both sides
  // (BR-PAY-012, BR-PAY-026): the payslip foots for an employee with a
  // calculator ---------------------------------------------------------------
  const sumKind = (kind: PayrollLineKind): Decimal =>
    lines.filter((l) => l.kind === kind).reduce((sum, l) => sum.plus(l.amount), ZERO);
  const netPay = sumKind('earning').minus(sumKind('deduction'));
  trace.push({
    step: 'net',
    input: `Σ earning ${sumKind('earning').toFixed(2)} − Σ deduction ${sumKind('deduction').toFixed(2)}`,
    output: netPay.toFixed(2),
    note: 'employer_cost outside both sides (BR-PAY-026)',
  });

  return ok({
    lines,
    bases: {
      upahSebulan: upahSebulan.toFixed(2),
      totalWage: totalWage.toFixed(2),
      overtimeHourlyBasis: overtimeHourlyBasis === null ? null : overtimeHourlyBasis.toFixed(2),
      prorationFactor: factor.toFixed(6),
    },
    taxable: { regular: tax.value.taxableRegular, irregular: tax.value.taxableIrregular },
    netPay: netPay.toFixed(2),
    trace: [...trace, ...bpjs.value.trace, ...tax.value.trace],
    warnings,
  });
}
