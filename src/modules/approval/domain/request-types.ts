/**
 * §13's consumer registry, as code.
 *
 * **The registry lives in the engine, not in the modules.** §13 says so in one
 * sentence — *"A new request type = module §13 declaration + registry entry
 * here, same session"* — and the alternative would not work anyway: chain
 * configuration and BR-APRV-003's provisioning seed both need the full list, and
 * nine of these ten modules do not exist yet. A `registerRequestType()` call
 * shaped like `registerAuditedTables` would leave the registry empty until
 * Phase 3, and an empty registry means no chain can be configured and nothing
 * can be submitted.
 *
 * The settings precedent is the closer one: a code-owned registry in the
 * platform module that owns the concept, appended to as consumers land.
 *
 * **Field names only, no types.** §13 says the declaration carries "name + type"
 * and five of the ten types state theirs; the other five state only names. The
 * fields exist here to answer one §8 question — *is this condition field
 * declared for this request type* — and inventing types for half the registry to
 * fill a column nothing reads would be worse than not having the column. The
 * chain editor's field list is admin-web work with no §7 endpoint behind it yet
 * (A-196).
 */
export const REQUEST_TYPE_CONTEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // leave.md §13
  'leave.request': [
    'employeeId',
    'companyId',
    'branchId',
    'departmentId',
    'leaveTypeCode',
    'isPaid',
    'dayCount',
    'startDate',
    'endDate',
    'hasAttachment',
    'balanceAfter',
  ],
  // overtime.md §13
  'overtime.request': [
    'employeeId',
    'companyId',
    'branchId',
    'departmentId',
    'jobLevelId',
    'dates',
    'plannedHours',
    'restDayHours',
    'compensation',
    'estimatedMultiplierHours',
  ],
  // attendance.md §13
  'attendance.correction': [
    'employeeId',
    'companyId',
    'branchId',
    'date',
    'hasAttachment',
    'minutesDelta',
  ],
  // expense-reimbursement.md §13
  'expense.claim': [
    'companyId',
    'employeeId',
    'branchId',
    'departmentId',
    'totalAmount',
    'lineCount',
    'categoryCodes',
    'overPolicyLineCount',
    'disburseVia',
  ],
  // employee.md §13
  'employee.data_change': ['fieldGroup'],
  'employee.resignation': ['lastDay'],
  // recruitment-candidate.md §13
  'recruitment.requisition': [
    'companyId',
    'positionId',
    'departmentId',
    'branchId',
    'jobLevelRank',
    'hiringManagerEmployeeId',
    'openings',
    'employmentType',
  ],
  'recruitment.offer': [
    'companyId',
    'requisitionId',
    'positionId',
    'departmentId',
    'branchId',
    'jobLevelRank',
    'offeredBaseSalary',
    'employmentType',
    'revisionNumber',
  ],
  // payroll.md §13
  payroll_run: ['companyId', 'type', 'totalNet', 'employeeCount'],
  // training.md §13
  'training.enrollment': [
    'companyId',
    'employeeId',
    'departmentId',
    'branchId',
    'courseId',
    'categoryId',
    'costAmount',
    'sessionStartDate',
  ],
};

export const REQUEST_TYPES: readonly string[] = Object.keys(REQUEST_TYPE_CONTEXT_FIELDS);

export function isRegisteredRequestType(requestType: string): boolean {
  return Object.hasOwn(REQUEST_TYPE_CONTEXT_FIELDS, requestType);
}

export function contextFieldsOf(requestType: string): readonly string[] {
  return REQUEST_TYPE_CONTEXT_FIELDS[requestType] ?? [];
}
