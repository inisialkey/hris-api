// The bpjs facade — the only import path other modules may use (ADR-0001 §1).
//
// Track 2 (implementation-roadmap §4.4) lands the pure calculator before the
// module around it. `BpjsCalculatorPort` — the adapter payroll invokes at
// pipeline stage 4 — arrives with the module in the business backbone;
// nothing imports this facade yet.

export {
  computeBpjs,
  type BpjsContribution,
  type BpjsInput,
  type BpjsPayer,
  type BpjsProgram,
  type BpjsResult,
  type BpjsRiskClass,
} from './domain/bpjs-calculator';
