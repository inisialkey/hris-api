// The employee facade — the only import path other modules may use (ADR-0001 §1).
//
// Two ports cross it and a **view** sits beside them, which is the shape
// employee.md §13 settled on and the reason ADR-0001 rule 6 was amended:
// `employee_directory` carries the identity columns every transactional grid in
// Phase 3 renders and filters on, and a port cannot serve a `WHERE full_name
// ILIKE …` that has to run before the page boundary. The view is a schema
// object, so consumers reach it through `src/database/schema` rather than
// through this file — dependency-lint permits `employee_directory` and keeps
// rejecting `employees`.
//
// `EmployeePayrollPort` (§13) is specified and not built: its first caller is a
// payroll run, and its `includeExited` semantics have no definition of correct
// until one exists (A-195).

export { EmployeeModule } from './employee.module';
export {
  EMPLOYEE_HIRE_PORT,
  EMPLOYEE_STATUS_PORT,
  type EmployeeHirePort,
  type EmployeeStatusPort,
} from './domain/employee.ports';
export type { EmployeeCreateInput, EmployeeStatus } from './domain/employee.types';
