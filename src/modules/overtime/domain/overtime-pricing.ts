import Decimal from 'decimal.js';

import { AppError } from '../../../shared/app-error';
import { fail, ok, Result } from '../../../shared/result';
import { overtimeErrors } from './overtime.errors';

/**
 * The overtime occurrence pricing calculator — overtime.md §4.5, as a pure
 * function over a snapshot slice (ADR-0012, implementation-roadmap §4.4
 * track 2). No ports, no clock, no database: same input, same output, forever.
 *
 * The seam it sits behind: this module owns labor law (what counts, which
 * tier), payroll owns wage law (the divisor, the basis, the money). Money
 * never appears here — the output is multiplier-hours, and `tiers` is the
 * payslip explain-view that lets the figure be reproduced years later.
 */

export type OvertimeDayClass = 'work_day' | 'rest_day';

/** One `overtime_rate_rules` row (BR-OVT-009 — platform data, effective-dated). */
export type OvertimeRateRule = {
  readonly dayClass: OvertimeDayClass;
  /** 0-based, ascending; the walk order. */
  readonly tierIndex: number;
  /** `standard_day` bounds are offsets added to H (overtime.md §4.2). */
  readonly boundsBasis: 'absolute' | 'standard_day';
  /** Decimal-string hours; NULL = 0 (the walk's origin, whatever the basis). */
  readonly fromHour: string | null;
  /** Decimal-string hours; NULL = unbounded. */
  readonly toHour: string | null;
  /** Decimal-string factor, numeric(4,2) — carried verbatim into the trace. */
  readonly factor: string;
};

export type OvertimePricingInput = {
  readonly dayClass: OvertimeDayClass;
  readonly plannedMinutes: number;
  /** `AttendanceQueryPort.daysFor(...).overtimeCandidateMinutes` — the meter. */
  readonly actualMinutes: number;
  /**
   * BR-OVT-013: `false` only for an on-behalf order the employee has not
   * acknowledged — it actualizes to zero, not silently paid, not dropped.
   */
  readonly acknowledged: boolean;
  /** `ScheduledDay.standardMinutes`; 0 on a genuine rest day (BR-OVT-010). */
  readonly scheduledStandardMinutes: number;
  /** `overtime.standard_daily_hours × 60` — the H fallback (BR-OVT-010). */
  readonly fallbackStandardDayMinutes: number;
  /** The effective row set for the occurrence's `rate_version`, both day classes. */
  readonly rules: readonly OvertimeRateRule[];
  /** `overtime.meal_threshold_hours × 60` (BR-OVT-012). */
  readonly mealThresholdMinutes: number;
  readonly compensation: 'pay' | 'toil';
};

/** One slice of the walk — the `tiers` jsonb pinned on the occurrence. */
export type OvertimeTierSlice = { readonly factor: string; readonly minutes: number };

export type OvertimePricing = {
  /** Resolved H in minutes, pinned on the occurrence at approval (BR-OVT-010). */
  readonly standardDayMinutes: number;
  /** `min(planned, actual)`, or 0 while unacknowledged (BR-OVT-008, BR-OVT-013). */
  readonly payableMinutes: number;
  /** Zero-minute tiers omitted — the trace records what happened, not the table. */
  readonly tiers: readonly OvertimeTierSlice[];
  /** `Σ (tierMinutes / 60) × factor`, numeric(8,4) decimal string (§4.5). */
  readonly multiplierHours: string;
  /** `payable > 0 && payable ≥ threshold` — derived from actual hours (BR-OVT-012). */
  readonly mealEntitled: boolean;
  /**
   * `multiplierHours × 60 / H` to numeric(6,2) when compensation is `toil`
   * (BR-OVT-011 — the credit is multiplier-hours, so conversion is not a pay
   * cut), else null. Derived from the *pinned* 4dp figure so the leave ledger
   * reconciles against the occurrence row. Rounding decisions: A-187.
   */
  readonly toilDays: string | null;
};

/** A tier with its bounds resolved to minutes: half-open `[from, to)`, `to = null` unbounded. */
type ResolvedTier = { from: number; to: number | null; factor: string };

/**
 * Resolve one bound to minutes. NULL `fromHour` means the walk's origin (0)
 * and NULL `toHour` means unbounded, regardless of basis; a non-null
 * `standard_day` value is an offset added to H (§4.2 — tier 0's upper bound
 * of 0 reads as H, tier 2's lower bound of 1 reads as H+1).
 *
 * Bounds must land on whole minutes. numeric(5,2) hours admits 0.01 h = 0.6
 * min, which would make the integer `tiers` trace lie about the split; every
 * statutory and fictional bound is a whole hour, so this is a validation,
 * not a limitation anyone meets.
 */
function resolveBoundMinutes(
  hour: string,
  basis: OvertimeRateRule['boundsBasis'],
  standardDayMinutes: number,
): number | null {
  const minutes = new Decimal(hour).times(60);
  if (!minutes.isInteger() || minutes.isNegative()) return null;
  return basis === 'standard_day' ? standardDayMinutes + minutes.toNumber() : minutes.toNumber();
}

function resolveTiers(
  rules: readonly OvertimeRateRule[],
  dayClass: OvertimeDayClass,
  standardDayMinutes: number,
): Result<ResolvedTier[], AppError> {
  const rows = rules
    .filter((r) => r.dayClass === dayClass)
    .sort((a, b) => a.tierIndex - b.tierIndex);

  // BR-OVT-009: a missing or unusable row set is a loud failure, never a
  // default factor. A malformed set (gap, overlap, bounded top tier) is the
  // same condition one notch later — there is no row set the walk can trust —
  // so it rides the same code with the defect named in `details`.
  const malformed = (detail: string) =>
    fail(overtimeErrors.rateRulesMissing({ dayClass, reason: 'malformed', detail }));
  if (rows.length === 0) {
    return fail(overtimeErrors.rateRulesMissing({ dayClass, reason: 'no_rows' }));
  }

  const tiers: ResolvedTier[] = [];
  for (const [i, row] of rows.entries()) {
    if (row.tierIndex !== i) return malformed(`tier indexes not contiguous at ${row.tierIndex}`);
    const from =
      row.fromHour === null
        ? 0
        : resolveBoundMinutes(row.fromHour, row.boundsBasis, standardDayMinutes);
    const to =
      row.toHour === null
        ? null
        : resolveBoundMinutes(row.toHour, row.boundsBasis, standardDayMinutes);
    if (from === null || (row.toHour !== null && to === null)) {
      return malformed(`tier ${row.tierIndex} bound is not a whole non-negative minute`);
    }
    tiers.push({ from, to, factor: row.factor });
  }

  for (const [i, tier] of tiers.entries()) {
    const isLast = i === tiers.length - 1;
    if (i === 0 && tier.from !== 0) return malformed('tier 0 does not start at zero');
    if (i > 0 && tier.from !== tiers[i - 1]!.to) {
      return malformed(`gap or overlap between tier ${i - 1} and tier ${i}`);
    }
    if (isLast && tier.to !== null) return malformed('top tier is bounded');
    if (!isLast && (tier.to === null || tier.to <= tier.from)) {
      return malformed(`tier ${i} is empty or unbounded before the top`);
    }
  }
  return ok(tiers);
}

/**
 * Price one occurrence. The §4.5 arithmetic in order: resolve H → clamp to
 * evidence → walk the tiers → weight → flag the meal → convert TOIL.
 *
 * The rule set is validated even when nothing is payable: an actualization
 * over a date with no effective rows must fail loudly (BR-OVT-009), not
 * succeed quietly because the employee happened not to work.
 */
export function priceOvertimeOccurrence(
  input: OvertimePricingInput,
): Result<OvertimePricing, AppError> {
  // BR-OVT-010: H is the scheduled day's standard minutes; a genuine rest day
  // schedules zero, so the settings value stands in.
  const standardDayMinutes =
    input.scheduledStandardMinutes > 0
      ? input.scheduledStandardMinutes
      : input.fallbackStandardDayMinutes;
  if (standardDayMinutes <= 0) {
    // Not a domain outcome — `overtime.standard_daily_hours` has a non-zero
    // default, so a zero H is a caller defect, and it would divide by zero below.
    throw new TypeError('standardDayMinutes resolved to <= 0');
  }

  const resolved = resolveTiers(input.rules, input.dayClass, standardDayMinutes);
  if (!resolved.ok) return resolved;

  // BR-OVT-008: the approval is the ceiling, attendance is the meter.
  // BR-OVT-013: an unacknowledged order actualizes to zero.
  const payableMinutes = input.acknowledged
    ? Math.min(input.plannedMinutes, input.actualMinutes)
    : 0;

  const tiers: OvertimeTierSlice[] = [];
  let weighted = new Decimal(0); // Σ minutes × factor, exact (A-016: decimal.js only)
  for (const tier of resolved.value) {
    const upper = tier.to === null ? payableMinutes : Math.min(payableMinutes, tier.to);
    const minutes = Math.max(0, upper - tier.from);
    if (minutes === 0) continue;
    tiers.push({ factor: tier.factor, minutes });
    weighted = weighted.plus(new Decimal(tier.factor).times(minutes));
  }

  // Single rounding of the exact sum to the column's 4 dp, half up (A-187).
  const multiplierHours = weighted.div(60).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

  return ok({
    standardDayMinutes,
    payableMinutes,
    tiers,
    multiplierHours,
    mealEntitled: payableMinutes > 0 && payableMinutes >= input.mealThresholdMinutes,
    toilDays:
      input.compensation === 'toil'
        ? new Decimal(multiplierHours)
            .times(60)
            .div(standardDayMinutes)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2)
        : null,
  });
}
