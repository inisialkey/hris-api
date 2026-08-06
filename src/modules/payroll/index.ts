// The payroll facade — the only import path other modules may use (ADR-0001 §1).
//
// Track 2 (implementation-roadmap §4.4) lands the pure pipeline before the
// module around it: no run, no snapshot machinery, no schema, no routes. The
// run lifecycle, retro machinery, and the BullMQ execution arrive with the
// module in the business backbone; nothing imports this facade yet.

export {
  computePayrollEmployee,
  type PayrollComponentInput,
  type PayrollEmployeeInput,
  type PayrollEmployeeResult,
  type PayrollIncomeClass,
  type PayrollLine,
  type PayrollLineKind,
  type PayrollWageCategory,
} from './domain/payroll-calculator';
