import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';

import { structuralFictionV1 } from '../../../../test/vectors/structural-fiction-v1';
import {
  priceOvertimeOccurrence,
  type OvertimePricing,
  type OvertimePricingInput,
  type OvertimeRateRule,
} from './overtime-pricing';

type VectorFile<I, E> = {
  engine: string;
  rateSet: string;
  vectors: { id: string; source: string; status?: string; input: I; expected: E }[];
};

const vectorsDir = join(__dirname, '..', '..', '..', '..', 'test', 'vectors');
const structural = JSON.parse(
  readFileSync(join(vectorsDir, 'overtime-pricing.structural.json'), 'utf8'),
) as VectorFile<Omit<OvertimePricingInput, 'rules'>, OvertimePricing>;
const statutory = JSON.parse(
  readFileSync(join(vectorsDir, 'overtime-pricing.statutory.json'), 'utf8'),
) as VectorFile<null, null>;

const rules = structuralFictionV1.overtimeRateRules;

// G7 — structural golden vectors (testing-strategy §6.2). Expected values in
// the JSON are hand-derived from overtime.md §4.5's formulas, never from
// running this implementation: a vector is never edited to make a test pass.
describe('BR-OVT-009, BR-OVT-010: overtime/occurrence-pricing structural vectors', () => {
  it('runs against the fictional rate set, not regulation', () => {
    expect(structural.rateSet).toBe(structuralFictionV1.rateSet);
    // ADR-0018 §4's load-bearing property: a uniform 2.00 factor cannot be
    // mistaken for (or drift toward) the statutory table.
    for (const rule of rules) expect(rule.factor).toBe('2.00');
  });

  for (const vector of structural.vectors) {
    it(`${vector.id} — ${vector.source.split('—')[0]?.trim() ?? ''}`, () => {
      const result = priceOvertimeOccurrence({ ...vector.input, rules });
      expect(result).toEqual({ ok: true, value: vector.expected });
    });
  }
});

describe('BR-OVT-009: a missing or unusable rate row set fails loudly, never a default factor', () => {
  const base: Omit<OvertimePricingInput, 'rules'> = {
    dayClass: 'work_day',
    plannedMinutes: 120,
    actualMinutes: 120,
    acknowledged: true,
    scheduledStandardMinutes: 420,
    fallbackStandardDayMinutes: 420,
    mealThresholdMinutes: 240,
    compensation: 'pay',
  };
  const workDay = (rows: Partial<OvertimeRateRule>[]): OvertimeRateRule[] =>
    rows.map((r, i) => ({
      dayClass: 'work_day',
      tierIndex: i,
      boundsBasis: 'absolute',
      fromHour: null,
      toHour: null,
      factor: '2.00',
      ...r,
    }));

  const expectMissing = (input: OvertimePricingInput, reason: 'no_rows' | 'malformed') => {
    const result = priceOvertimeOccurrence(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('OVT_RATE_RULES_MISSING');
    expect(result.error.details).toMatchObject({ reason });
  };

  it('no rows for the day class', () => {
    expectMissing({ ...base, rules: rules.filter((r) => r.dayClass === 'rest_day') }, 'no_rows');
  });

  it('a gap between tiers', () => {
    expectMissing(
      { ...base, rules: workDay([{ toHour: '1.00' }, { fromHour: '2.00' }]) },
      'malformed',
    );
  });

  it('overlapping tiers', () => {
    expectMissing(
      { ...base, rules: workDay([{ toHour: '2.00' }, { fromHour: '1.00' }]) },
      'malformed',
    );
  });

  it('a bounded top tier', () => {
    expectMissing(
      { ...base, rules: workDay([{ toHour: '1.00' }, { fromHour: '1.00', toHour: '9.00' }]) },
      'malformed',
    );
  });

  it('tier 0 not starting at zero', () => {
    expectMissing(
      { ...base, rules: workDay([{ fromHour: '0.50', toHour: '1.00' }, { fromHour: '1.00' }]) },
      'malformed',
    );
  });

  it('non-contiguous tier indexes', () => {
    expectMissing(
      { ...base, rules: workDay([{ toHour: '1.00' }, { fromHour: '1.00', tierIndex: 2 }]) },
      'malformed',
    );
  });

  it('a bound not on a whole minute (0.01 h = 0.6 min would make the integer trace lie)', () => {
    expectMissing(
      { ...base, rules: workDay([{ toHour: '0.01' }, { fromHour: '0.01' }]) },
      'malformed',
    );
  });

  it('validates the row set even when nothing is payable', () => {
    expectMissing({ ...base, actualMinutes: 0, rules: [] }, 'no_rows');
  });

  it('a zero H is a caller defect, not a domain outcome', () => {
    expect(() =>
      priceOvertimeOccurrence({
        ...base,
        rules,
        scheduledStandardMinutes: 0,
        fallbackStandardDayMinutes: 0,
      }),
    ).toThrow(TypeError);
  });
});

// G8 — P2 (testing-strategy §6.5): for any duration, the tier walk covers it
// with no gap and no overlap. Sum equality over disjoint half-open intervals
// proves both: a gap would drop minutes, an overlap would count them twice.
describe('BR-OVT-009 — P2: the tier walk covers any duration exactly', () => {
  it('Σ tier minutes equals payable minutes, every slice positive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2880 }),
        fc.constantFrom<'work_day' | 'rest_day'>('work_day', 'rest_day'),
        fc.constantFrom(300, 420, 480),
        (minutes, dayClass, scheduledStandardMinutes) => {
          const result = priceOvertimeOccurrence({
            dayClass,
            plannedMinutes: minutes,
            actualMinutes: minutes,
            acknowledged: true,
            scheduledStandardMinutes,
            fallbackStandardDayMinutes: 420,
            rules,
            mealThresholdMinutes: 240,
            compensation: 'pay',
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const total = result.value.tiers.reduce((sum, t) => sum + t.minutes, 0);
          expect(total).toBe(minutes);
          for (const tier of result.value.tiers) expect(tier.minutes).toBeGreaterThan(0);
        },
      ),
    );
  });
});

// G20's merge-side guard: the statutory file stays quarantined until a human
// verifies it. The runner refuses a "verified" entry outright — the statutory
// rate set it would need is not wired, so an un-skipped vector here could only
// pass vacuously, which is the failure ADR-0018 exists to prevent.
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
