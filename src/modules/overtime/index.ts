// The overtime facade — the only import path other modules may use (ADR-0001 §1).
//
// Track 2 (implementation-roadmap §4.4) lands the pricing calculator before the
// module around it: pure arithmetic, no schema, no routes, no NestJS module.
// `OvertimeQueryPort` — the seam payroll actually consumes — arrives with the
// module in the business backbone (§4.3); nothing imports this facade yet.

export {
  priceOvertimeOccurrence,
  type OvertimeDayClass,
  type OvertimePricing,
  type OvertimePricingInput,
  type OvertimeRateRule,
  type OvertimeTierSlice,
} from './domain/overtime-pricing';
