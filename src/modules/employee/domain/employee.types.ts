/** Row shapes the module passes around, independent of Drizzle's inferred types. */

export type Gender = 'male' | 'female';
export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed';
export type Religion = 'islam' | 'protestant' | 'catholic' | 'hindu' | 'buddhist' | 'confucian';
export type PtkpStatus =
  | 'tk_0'
  | 'tk_1'
  | 'tk_2'
  | 'tk_3'
  | 'k_0'
  | 'k_1'
  | 'k_2'
  | 'k_3'
  | 'k_i_0'
  | 'k_i_1'
  | 'k_i_2'
  | 'k_i_3';
export type EmployeeStatus = 'active' | 'on_leave' | 'resigned' | 'terminated';
export type EmploymentType = 'pkwt' | 'pkwtt';
export type FamilyRelationship = 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
export type StatusSource = 'hire' | 'resignation' | 'termination' | 'leave' | 'admin';

/**
 * The ADR-0016 encrypted set, named once.
 *
 * It is a type rather than a comment because BR-EMP-003's masking matrix, the
 * reveal payload, and the data-change `bank` whitelist all quantify over exactly
 * these fields, and three hand-kept lists would drift.
 */
export interface EncryptedSet {
  nik: string;
  npwp: string | null;
  bpjsKesehatanNumber: string | null;
  bpjsKetenagakerjaanNumber: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
}

/** Plaintext as the repository hands it over — decryption already happened. */
export interface EmployeeRow extends EncryptedSet {
  id: string;
  companyId: string;
  userId: string | null;
  employeeNumber: string;
  fullName: string;
  joinDate: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  bankName: string | null;
  birthPlace: string | null;
  birthDate: string;
  gender: Gender;
  maritalStatus: MaritalStatus;
  religion: Religion | null;
  ptkpStatus: PtkpStatus;
  address: string | null;
  phone: string | null;
  personalEmail: string | null;
  updatedAt: Date;
}

/**
 * §4.3's list shape. **The encrypted set is not in it, and that is enforced by
 * the query rather than by a mapper** — ADR-0016's tradeoff section promises
 * that the fields are *"read on profile/payroll-setup paths, never in hot list
 * queries (masked list views don't decrypt)"*, and a grid that selected them and
 * dropped them afterwards would be paying a per-row crypto hop and a DEK unwrap
 * to produce a payload that never carries them.
 */
export type EmployeeListRow = Omit<EmployeeRow, keyof EncryptedSet | 'bankName'>;

/** The create shape of §7, which is also `EmployeeHirePort`'s argument. */
export interface EmployeeCreateInput {
  companyId: string;
  fullName: string;
  nik: string;
  npwp?: string | null;
  birthPlace?: string | null;
  birthDate: string;
  gender: Gender;
  maritalStatus: MaritalStatus;
  religion?: Religion | null;
  ptkpStatus: PtkpStatus;
  address?: string | null;
  phone?: string | null;
  personalEmail?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountHolder?: string | null;
  bpjsKesehatanNumber?: string | null;
  bpjsKetenagakerjaanNumber?: string | null;
  employeeNumber?: string | null;
  joinDate: string;
  employmentType: EmploymentType;
  contractEndDate?: string | null;
  contractFileId?: string | null;
  positionId: string;
  branchId: string;
  createAccount?: { email: string } | null;
}

/** §7's PATCH surface: every master field except the four §7 forbids. */
export type EmployeeUpdateInput = Partial<
  Omit<
    EmployeeCreateInput,
    | 'companyId'
    | 'employeeNumber'
    | 'employmentType'
    | 'contractEndDate'
    | 'contractFileId'
    | 'positionId'
    | 'branchId'
    | 'createAccount'
  >
>;

export interface ContractRow {
  id: string;
  employeeId: string;
  kind: EmploymentType;
  startDate: string;
  endDate: string | null;
  fileId: string | null;
  note: string | null;
  lastRemindedDays: number | null;
  createdBy: string | null;
}

export interface StatusHistoryRow {
  id: string;
  employeeId: string;
  status: EmployeeStatus;
  source: StatusSource;
  sourceId: string | null;
  effectiveDate: string;
  reason: string | null;
  appliedAt: Date | null;
}

export interface FamilyMemberRow {
  id: string;
  employeeId: string;
  name: string;
  relationship: FamilyRelationship;
  birthDate: string | null;
  phone: string | null;
  isEmergencyContact: boolean;
}

/** `employee_directory`'s column list — the ADR-0001 rule 6 boundary, as a type. */
export interface DirectoryRow {
  employeeId: string;
  companyId: string;
  userId: string | null;
  employeeNumber: string;
  fullName: string;
  status: EmployeeStatus;
  joinDate: string;
}
