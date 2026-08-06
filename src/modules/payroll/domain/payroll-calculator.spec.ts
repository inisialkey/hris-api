import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Decimal from 'decimal.js';
import fc from 'fast-check';

import { structuralFictionV1 } from '../../../../test/vectors/structural-fiction-v1';
import {
  computePayrollEmployee,
  type PayrollEmployeeInput,
  type PayrollEmployeeResult,
} from './payroll-calculator';

type VectorFile<I, E> = {
  engine: string;
  rateSet: string;
  vectors: { id: string; source: string; status?: string; input: I; expected: E }[];
};

type VectorExpected = Pick<
  PayrollEmployeeResult,
  'lines' | 'bases' | 'taxable' | 'netPay' | 'warnings'
>;

const vectorsDir = join(__dirname, '..', '..', '..', '..', 'test', 'vectors');
const structural = JSON.parse(
  readFileSync(join(vectorsDir, 'payroll-pipeline.structural.json'), 'utf8'),
) as VectorFile<Omit<PayrollEmployeeInput, 'parameters'>, VectorExpected>;
const statutory = JSON.parse(
  readFileSync(join(vectorsDir, 'payroll-pipeline.statutory.json'), 'utf8'),
) as VectorFile<null, null>;

/** The fictional parameter slice for all three engines (BR-PAY-009). */
const parameters: PayrollEmployeeInput['parameters'] = {
  payroll: { scalars: structuralFictionV1.payroll.scalars },
  bpjs: {
    versionAsOf: '2026-01-01',
    programs: structuralFictionV1.bpjs.programRates,
    jkkRates: structuralFictionV1.bpjs.jkkRates,
    scalars: structuralFictionV1.bpjs.scalars,
  },
  tax: {
    versionAsOf: '2026-01-01',
    ptkpAnnualAmount: structuralFictionV1.tax.ptkpAnnualAmount,
    terBands: structuralFictionV1.tax.terBands,
    progressiveBands: structuralFictionV1.tax.progressiveBands,
    severanceBands: structuralFictionV1.tax.severanceBands,
    scalars: structuralFictionV1.tax.scalars,
  },
};

const run = (input: Omit<PayrollEmployeeInput, 'parameters'>) =>
  computePayrollEmployee({ ...input, parameters });

// G7 — structural golden vectors, and ADR-0012's golden-file class in
// miniature: fixed snapshot slice in, exact line set out. Expected values are
// hand-derived from payroll.md §4.5 and the fictional rates, never from
// running this implementation.
describe('BR-PAY-003, BR-PAY-004, BR-PAY-012, BR-PAY-013, BR-PAY-015, BR-PAY-026: payroll/employee-pipeline structural vectors', () => {
  it('runs against the fictional rate set, not regulation', () => {
    expect(structural.rateSet).toBe(structuralFictionV1.rateSet);
  });

  for (const vector of structural.vectors) {
    it(`${vector.id} — ${vector.source.split('—')[0]?.trim() ?? ''}`, () => {
      const result = run(vector.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { trace, ...rest } = result.value;
      expect(rest).toEqual(vector.expected);
      expect(trace.length).toBeGreaterThan(1);
      // BR-PAY-012: the payslip foots — the returned net equals the sum of
      // the returned rounded lines, employer_cost outside both sides.
      const foot = result.value.lines.reduce(
        (sum, l) =>
          l.kind === 'earning'
            ? sum.plus(l.amount)
            : l.kind === 'deduction'
              ? sum.minus(l.amount)
              : sum,
        new Decimal(0),
      );
      expect(foot.toFixed(2)).toBe(result.value.netPay);
    });
  }

  it('BR-PAY-009 — same snapshot slice, byte-identical result', () => {
    const input = structural.vectors[0]!.input;
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });
});

describe('BR-PAY-009: an absent parameter fails loudly, through every stage', () => {
  const base = structural.vectors[0]!.input;

  const expectMissing = (input: PayrollEmployeeInput, parameter: string) => {
    const result = computePayrollEmployee(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PAY_PARAMETER_MISSING');
    expect(result.error.details).toMatchObject({ parameter });
  };

  it('missing line rounding unit', () => {
    expectMissing(
      { ...base, parameters: { ...parameters, payroll: { scalars: {} } } },
      'payroll.line_rounding_unit',
    );
  });

  it('missing overtime divisor when overtime is present', () => {
    const overtime = structural.vectors.find((v) => v.id === 'overtime-basis-floor-binds')!;
    expectMissing(
      {
        ...overtime.input,
        parameters: {
          ...parameters,
          payroll: { scalars: { line_rounding_unit: '100.00' } },
        },
      },
      'payroll.overtime_divisor',
    );
  });

  it('a sibling calculator failure propagates unchanged (empty TER bands)', () => {
    expectMissing(
      { ...base, parameters: { ...parameters, tax: { ...parameters.tax, terBands: [] } } },
      'tax_ter_rates.a',
    );
  });
});

// G8 — P1 and P3 (testing-strategy §6.5).
describe('payroll properties', () => {
  const withBasic = (amount: number, proration: PayrollEmployeeInput['proration']) =>
    run({
      ...structural.vectors[0]!.input,
      components: [
        {
          code: 'basic',
          kind: 'earning',
          wageCategory: 'basic',
          incomeClass: 'regular',
          amount: `${amount}.00`,
          proratable: true,
        },
      ],
      proration,
    });

  it('P1 — BR-PAY-012: the sum of rounded component parts equals the rounded whole', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20_000_000 }), { minLength: 1, maxLength: 6 }),
        (amounts) => {
          const result = run({
            ...structural.vectors[0]!.input,
            components: amounts.map((amount, i) => ({
              code: `c${i}`,
              kind: 'earning' as const,
              wageCategory: 'basic' as const,
              incomeClass: 'regular' as const,
              amount: `${amount}.00`,
              proratable: false,
            })),
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const foot = result.value.lines.reduce(
            (sum, l) =>
              l.kind === 'earning'
                ? sum.plus(l.amount)
                : l.kind === 'deduction'
                  ? sum.minus(l.amount)
                  : sum,
            new Decimal(0),
          );
          expect(foot.toFixed(2)).toBe(result.value.netPay);
        },
      ),
    );
  });

  it('P3 — BR-PAY-013: a prorated amount lies in [0, full] and is monotonic in days worked', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 20_000_000 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (amount, d1, d2) => {
          const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const at = (days: number) => {
            const result = withBasic(amount, {
              basis: 'calendar_days',
              daysInPeriod: 30,
              daysPayable: days,
              fixedDailyDivisor: null,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return new Decimal(0);
            return new Decimal(result.value.lines.find((l) => l.code === 'basic')?.amount ?? '0');
          };
          const full = new Decimal(amount);
          const loAmount = at(lo);
          const hiAmount = at(hi);
          expect(loAmount.greaterThanOrEqualTo(0)).toBe(true);
          expect(hiAmount.lessThanOrEqualTo(full.plus(50))).toBe(true); // + half the line unit
          expect(hiAmount.greaterThanOrEqualTo(loAmount)).toBe(true);
        },
      ),
    );
  });
});

// G20's merge-side guard — same contract as the other statutory files.
describe('statutory vectors stay pending-verification until track 3 verifies them', () => {
  it('every entry is pending-verification with no invented numbers', () => {
    expect(statutory.vectors.length).toBeGreaterThan(0);
    for (const vector of statutory.vectors) {
      expect(vector.status).toBe('pending-verification');
      expect(vector.input).toBeNull();
      expect(vector.expected).toBeNull();
    }
  });

  for (const vector of statutory.vectors) {
    it.skip(`${vector.id} — pending verification (track 3)`, () => undefined);
  }
});
