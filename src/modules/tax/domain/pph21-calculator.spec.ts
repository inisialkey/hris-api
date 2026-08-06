import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';

import { structuralFictionV1 } from '../../../../test/vectors/structural-fiction-v1';
import { computePph21, type Pph21Input, type Pph21Result } from './pph21-calculator';

type VectorFile<I, E> = {
  engine: string;
  rateSet: string;
  vectors: { id: string; source: string; status?: string; input: I; expected: E }[];
};

type VectorExpected = Pick<
  Pph21Result,
  'withholding' | 'taxAllowance' | 'finalTax' | 'taxableRegular' | 'taxableIrregular'
>;

const vectorsDir = join(__dirname, '..', '..', '..', '..', 'test', 'vectors');
const structural = JSON.parse(
  readFileSync(join(vectorsDir, 'tax-pph21.structural.json'), 'utf8'),
) as VectorFile<Omit<Pph21Input, 'parameters'>, VectorExpected>;
const statutory = JSON.parse(
  readFileSync(join(vectorsDir, 'tax-pph21.statutory.json'), 'utf8'),
) as VectorFile<null, null>;

/** The fictional parameter slice, as the adapter would assemble it (BR-TAX-017). */
const parameters: Pph21Input['parameters'] = {
  versionAsOf: '2026-01-01',
  ptkpAnnualAmount: structuralFictionV1.tax.ptkpAnnualAmount,
  terBands: structuralFictionV1.tax.terBands,
  progressiveBands: structuralFictionV1.tax.progressiveBands,
  severanceBands: structuralFictionV1.tax.severanceBands,
  scalars: structuralFictionV1.tax.scalars,
};

const run = (input: Omit<Pph21Input, 'parameters'>) => computePph21({ ...input, parameters });

// G7 — structural golden vectors. Expected values in the JSON are hand-derived
// from tax-pph21.md §4.6's paths and the fictional rates, never from running
// this implementation: a vector is never edited to make a test pass.
describe('BR-TAX-006, BR-TAX-008, BR-TAX-010, BR-TAX-011: tax-pph21/withholding structural vectors', () => {
  it('runs against the fictional rate set, not regulation', () => {
    expect(structural.rateSet).toBe(structuralFictionV1.rateSet);
  });

  for (const vector of structural.vectors) {
    it(`${vector.id} — ${vector.source.split('—')[0]?.trim() ?? ''}`, () => {
      const result = run(vector.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { trace, warnings, ...figures } = result.value;
      expect(figures).toEqual(vector.expected);
      // Trace completeness (ADR-0018 §3): the explain-view always carries the
      // base assembly and the figure's provenance.
      expect(trace.map((t) => t.step)).toContain('bruto');
      expect(trace.length).toBeGreaterThan(1);
      expect(warnings).toEqual([]);
    });
  }

  it('BR-TAX-017 — same input, byte-identical result', () => {
    const input = structural.vectors[0]!.input;
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });
});

describe('BR-TAX-001: an absent statutory parameter fails loudly, never a default', () => {
  const base = structural.vectors[0]!.input;

  const expectMissing = (input: Pph21Input, parameter: string) => {
    const result = computePph21(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PAY_PARAMETER_MISSING');
    expect(result.error.details).toMatchObject({ parameter });
  };

  const scalarsWithout = (key: string): Record<string, string> =>
    Object.fromEntries(Object.entries(parameters.scalars).filter(([k]) => k !== key));

  it('missing PPh 21 rounding unit', () => {
    expectMissing(
      { ...base, parameters: { ...parameters, scalars: scalarsWithout('pph21_rounding_unit') } },
      'tax_parameters.pph21_rounding_unit',
    );
  });

  it('empty TER band set on the monthly path', () => {
    expectMissing({ ...base, parameters: { ...parameters, terBands: [] } }, 'tax_ter_rates.a');
  });

  it('empty progressive band set on the annual path', () => {
    const annual = structural.vectors.find(
      (v) => v.id === 'annual-three-brackets-annual-cap-binds',
    )!;
    expectMissing(
      { ...annual.input, parameters: { ...parameters, progressiveBands: [] } },
      'tax_brackets',
    );
  });

  it('empty severance band set with a final line present', () => {
    const severance = structural.vectors.find((v) => v.id === 'severance-priced-on-its-own-bands')!;
    expectMissing(
      { ...severance.input, parameters: { ...parameters, severanceBands: [] } },
      'tax_severance_brackets',
    );
  });

  it('missing biaya jabatan percentage on the annual path', () => {
    const annual = structural.vectors.find(
      (v) => v.id === 'annual-three-brackets-annual-cap-binds',
    )!;
    expectMissing(
      {
        ...annual.input,
        parameters: { ...parameters, scalars: scalarsWithout('biaya_jabatan_pct') },
      },
      'tax_parameters.biaya_jabatan_pct',
    );
  });
});

// G8 — P5 (testing-strategy §6.5): gross-up never decreases tax; the bracket
// and TER walks are monotonic in gross.
describe('BR-TAX-006, BR-TAX-010 — P5: monotonicity and gross-up dominance', () => {
  const monthly = (amount: number, method: 'gross' | 'gross_up') =>
    run({
      taxYear: 2026,
      paymentDate: '2026-03-25',
      path: 'monthly',
      employee: {
        ptkpStatus: 'TK/0',
        terCategory: 'a',
        hasNpwp: true,
        method,
        monthsEmployedInYear: 12,
      },
      lines: [{ componentCode: 'basic_salary', incomeClass: 'regular', amount: `${amount}.00` }],
      deductibleContributions: { jht: '0.00', jp: '0.00' },
      mtd: { bruto: '0.00', pph21Withheld: '0.00' },
      ytd: {
        gross: '0.00',
        taxableRegular: '0.00',
        taxableIrregular: '0.00',
        pph21Withheld: '0.00',
        finalIncome: '0.00',
        pph21Final: '0.00',
      },
    });

  it('the TER walk is monotonic in gross', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40_000_000 }),
        fc.integer({ min: 0, max: 40_000_000 }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const wLo = monthly(lo, 'gross');
          const wHi = monthly(hi, 'gross');
          expect(wLo.ok && wHi.ok).toBe(true);
          if (!wLo.ok || !wHi.ok) return;
          expect(Number(wHi.value.withholding)).toBeGreaterThanOrEqual(
            Number(wLo.value.withholding),
          );
        },
      ),
    );
  });

  it('gross-up never decreases tax', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40_000_000 }), (amount) => {
        const gross = monthly(amount, 'gross');
        const grossUp = monthly(amount, 'gross_up');
        expect(gross.ok && grossUp.ok).toBe(true);
        if (!gross.ok || !grossUp.ok) return;
        expect(Number(grossUp.value.withholding)).toBeGreaterThanOrEqual(
          Number(gross.value.withholding),
        );
      }),
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
