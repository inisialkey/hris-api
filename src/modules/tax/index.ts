// The tax facade — the only import path other modules may use (ADR-0001 §1).
//
// Track 2 (implementation-roadmap §4.4) lands the pure calculator before the
// module around it. `Pph21CalculatorPort` — the adapter payroll invokes at
// pipeline stage 6 — arrives with the module in the business backbone;
// nothing imports this facade yet.

export {
  computePph21,
  type Pph21Band,
  type Pph21IncomeClass,
  type Pph21Input,
  type Pph21Result,
} from './domain/pph21-calculator';
