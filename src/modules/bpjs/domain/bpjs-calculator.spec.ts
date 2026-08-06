import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { structuralFictionV1 } from '../../../../test/vectors/structural-fiction-v1';
import { computeBpjs, type BpjsInput, type BpjsResult } from './bpjs-calculator';

type VectorFile<I, E> = {
  engine: string;
  rateSet: string;
  vectors: { id: string; source: string; status?: string; input: I; expected: E }[];
};

type VectorExpected = Pick<BpjsResult, 'contributions' | 'deductibleContributions' | 'warnings'>;

const vectorsDir = join(__dirname, '..', '..', '..', '..', 'test', 'vectors');
const structural = JSON.parse(
  readFileSync(join(vectorsDir, 'bpjs-contributions.structural.json'), 'utf8'),
) as VectorFile<Omit<BpjsInput, 'parameters'>, VectorExpected>;
const statutory = JSON.parse(
  readFileSync(join(vectorsDir, 'bpjs-contributions.statutory.json'), 'utf8'),
) as VectorFile<null, null>;

/** The fictional parameter slice, as the adapter would assemble it (BR-BPJS-015). */
const parameters: BpjsInput['parameters'] = {
  versionAsOf: '2026-01-01',
  programs: structuralFictionV1.bpjs.programRates,
  jkkRates: structuralFictionV1.bpjs.jkkRates,
  scalars: structuralFictionV1.bpjs.scalars,
};

const run = (input: Omit<BpjsInput, 'parameters'>) => computeBpjs({ ...input, parameters });

// G7 — structural golden vectors. Expected values in the JSON are hand-derived
// from bpjs.md §4.3's ladder and the fictional rates, never from running this
// implementation: a vector is never edited to make a test pass.
describe('BR-BPJS-002, BR-BPJS-008, BR-BPJS-009, BR-BPJS-010: bpjs/monthly-contributions structural vectors', () => {
  it('runs against the fictional rate set, not regulation', () => {
    expect(structural.rateSet).toBe(structuralFictionV1.rateSet);
  });

  for (const vector of structural.vectors) {
    it(`${vector.id} — ${vector.source.split('—')[0]?.trim() ?? ''}`, () => {
      const result = run(vector.input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.contributions).toEqual(vector.expected.contributions);
      expect(result.value.deductibleContributions).toEqual(vector.expected.deductibleContributions);
      expect(result.value.warnings).toEqual(vector.expected.warnings);
      // Trace completeness (ADR-0018 §3): every emitted line is explained by a
      // step the payslip explain-view can show.
      for (const line of result.value.contributions) {
        const step =
          line.componentCode === 'bpjs_kesehatan_dependents_ee'
            ? 'kesehatan.dependents'
            : `${line.program}.${line.payer}`;
        expect(result.value.trace.map((t) => t.step)).toContain(step);
      }
    });
  }

  it('BR-BPJS-015 — same input, byte-identical result', () => {
    const input = structural.vectors[0]!.input;
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });
});

describe('BR-BPJS-001: an absent statutory parameter fails loudly, never a default', () => {
  const base = structural.vectors[0]!.input;

  const expectMissing = (input: BpjsInput, parameter: string) => {
    const result = computeBpjs(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PAY_PARAMETER_MISSING');
    expect(result.error.details).toMatchObject({ parameter });
  };

  const scalarsWithout = (key: string): Record<string, string> =>
    Object.fromEntries(Object.entries(parameters.scalars).filter(([k]) => k !== key));

  it('missing rounding unit', () => {
    expectMissing(
      {
        ...base,
        parameters: { ...parameters, scalars: scalarsWithout('contribution_rounding_unit') },
      },
      'bpjs_parameters.contribution_rounding_unit',
    );
  });

  it('missing JP age ceiling while JP is enabled', () => {
    expectMissing(
      { ...base, parameters: { ...parameters, scalars: scalarsWithout('jp_max_age_years') } },
      'bpjs_parameters.jp_max_age_years',
    );
  });

  it('missing rate row for an enabled program', () => {
    const programs = parameters.programs.filter(
      (r) => !(r.program === 'jht' && r.payer === 'employer'),
    );
    expectMissing(
      { ...base, parameters: { ...parameters, programs } },
      'bpjs_program_rates.jht.employer',
    );
  });

  it('missing risk row for the company class', () => {
    const jkkRates = parameters.jkkRates.filter((r) => r.riskClass !== 'ii');
    expectMissing({ ...base, parameters: { ...parameters, jkkRates } }, 'bpjs_jkk_risk_rates.ii');
  });

  it('missing dependent surcharge rate while a count is set', () => {
    expectMissing(
      {
        ...base,
        employee: { ...base.employee, additionalDependents: 2 },
        parameters: { ...parameters, scalars: scalarsWithout('kesehatan_extra_dependent_pct') },
      },
      'bpjs_parameters.kesehatan_extra_dependent_pct',
    );
  });

  it('JKK enabled with no risk class skips with a warning, not a default (migrated data only)', () => {
    const result = run({ ...base, company: { ...base.company, jkkRiskClass: null } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toEqual([{ code: 'jkk_risk_class_missing' }]);
    expect(result.value.contributions.some((c) => c.program === 'jkk')).toBe(false);
  });
});

// G20's merge-side guard — same contract as the overtime statutory file.
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
