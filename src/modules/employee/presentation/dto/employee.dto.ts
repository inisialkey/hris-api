import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * §8's validation rules. The division of labour is ADR-0006's, restated once
 * because everyone gets it wrong: **the DTO rejects garbage** — a 15-digit NIK,
 * a birth date in the future, an unknown enum — and the use case rejects **rule
 * violations** — a NIK already held by a live employee, a contract that
 * overlaps. Never the same check in both places.
 */

const GENDERS = ['male', 'female'] as const;
const MARITAL = ['single', 'married', 'divorced', 'widowed'] as const;
const RELIGIONS = ['islam', 'protestant', 'catholic', 'hindu', 'buddhist', 'confucian'] as const;
const PTKP = [
  'tk_0',
  'tk_1',
  'tk_2',
  'tk_3',
  'k_0',
  'k_1',
  'k_2',
  'k_3',
  'k_i_0',
  'k_i_1',
  'k_i_2',
  'k_i_3',
] as const;
const RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'other'] as const;
const EMPLOYMENT_TYPES = ['pkwt', 'pkwtt'] as const;
const STATUSES = ['active', 'on_leave', 'resigned', 'terminated'] as const;

const NIK = /^\d{16}$/;
const NPWP = /^\d{15,16}$/;
const BPJS = /^\d{8,16}$/;
const PHONE = /^\+?\d{8,15}$/;
/** §8: 3–20, `[A-Z0-9-]`, unique per company. */
const EMPLOYEE_NUMBER = /^[A-Z0-9-]{3,20}$/;
const BANK_ACCOUNT = /^\d{6,30}$/;

class OffsetQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class EmployeeQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ description: 'Matches full name or employee number' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

class CreateAccountDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}

/**
 * §7's PATCH surface: every master field, all optional.
 *
 * `companyId` (transfer is terminate + rehire), `employeeNumber` (identity),
 * `employmentType`, and `status` (machine-only) are **absent rather than
 * ignored** — `forbidNonWhitelisted` turns a client sending one into a loud
 * `VAL_VALIDATION_FAILED` instead of a silent no-op (api-standards §3).
 *
 * Deliberately **not** extended by `CreateEmployeeDto`. class-validator merges
 * decorator metadata down the prototype chain, so an inherited `@IsOptional()`
 * would silently make the create form's required fields optional — the DRY win
 * would cost the validation.
 */
export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 150)
  fullName?: string;

  @ApiPropertyOptional({ description: '16 digits' })
  @IsOptional()
  @Matches(NIK)
  nik?: string;

  @ApiPropertyOptional({ description: '15–16 digits' })
  @IsOptional()
  @Matches(NPWP)
  npwp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  birthPlace?: string;

  @ApiPropertyOptional({ example: '1990-05-04' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: (typeof GENDERS)[number];

  @ApiPropertyOptional({ enum: MARITAL })
  @IsOptional()
  @IsIn(MARITAL)
  maritalStatus?: (typeof MARITAL)[number];

  @ApiPropertyOptional({ enum: RELIGIONS, description: 'THR eligibility mapping (A-020)' })
  @IsOptional()
  @IsIn(RELIGIONS)
  religion?: (typeof RELIGIONS)[number];

  @ApiPropertyOptional({ enum: PTKP })
  @IsOptional()
  @IsIn(PTKP)
  ptkpStatus?: (typeof PTKP)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: '+628123456789' })
  @IsOptional()
  @Matches(PHONE)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  personalEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(BANK_ACCOUNT)
  bankAccountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 150)
  bankAccountHolder?: string;

  @ApiPropertyOptional({ description: '8–16 digits' })
  @IsOptional()
  @Matches(BPJS)
  bpjsKesehatanNumber?: string;

  @ApiPropertyOptional({ description: '8–16 digits' })
  @IsOptional()
  @Matches(BPJS)
  bpjsKetenagakerjaanNumber?: string;
}

export class CreateEmployeeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 150)
  fullName!: string;

  @ApiProperty({ description: '16 digits' })
  @Matches(NIK)
  nik!: string;

  @ApiPropertyOptional({ description: '15–16 digits' })
  @IsOptional()
  @Matches(NPWP)
  npwp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  birthPlace?: string;

  /**
   * §8 bounds it *"between 1940-01-01 and today − 15 years (working-age
   * floor)"* and carries a `⚠️ VERIFY` on the fifteen. An assistant never types
   * a regulatory number (`ai-development-guide.md` §5), so the floor is **not
   * implemented here** — the format is checked and the age rule waits for a
   * human to confirm it, exactly as a statutory vector does. A-195.
   */
  @ApiProperty({ example: '1990-05-04' })
  @IsDateString()
  birthDate!: string;

  @ApiProperty({ enum: GENDERS })
  @IsIn(GENDERS)
  gender!: (typeof GENDERS)[number];

  @ApiProperty({ enum: MARITAL })
  @IsIn(MARITAL)
  maritalStatus!: (typeof MARITAL)[number];

  @ApiPropertyOptional({ enum: RELIGIONS, description: 'THR eligibility mapping (A-020)' })
  @IsOptional()
  @IsIn(RELIGIONS)
  religion?: (typeof RELIGIONS)[number];

  /** > ⚠️ VERIFY: the PTKP category set (§4.1) is regulation-dependent. */
  @ApiProperty({ enum: PTKP })
  @IsIn(PTKP)
  ptkpStatus!: (typeof PTKP)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: '+628123456789' })
  @IsOptional()
  @Matches(PHONE)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  personalEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(BANK_ACCOUNT)
  bankAccountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 150)
  bankAccountHolder?: string;

  @ApiPropertyOptional({ description: '8–16 digits' })
  @IsOptional()
  @Matches(BPJS)
  bpjsKesehatanNumber?: string;

  @ApiPropertyOptional({ description: '8–16 digits' })
  @IsOptional()
  @Matches(BPJS)
  bpjsKetenagakerjaanNumber?: string;

  @ApiPropertyOptional({ description: 'Blank takes the next value from the company counter' })
  @IsOptional()
  @Matches(EMPLOYEE_NUMBER)
  employeeNumber?: string;

  @ApiProperty({ example: '2026-08-01' })
  @IsDateString()
  joinDate!: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ description: 'Required when employmentType is pkwt (BR-EMP-007)' })
  @IsOptional()
  @IsDateString()
  contractEndDate?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contractFileId?: string;

  @ApiProperty({ format: 'uuid', description: 'BR-ORG-002 — mandatory at create' })
  @IsUUID()
  positionId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ description: 'Creates the login and queues the invite' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateAccountDto)
  createAccount?: CreateAccountDto;
}

export class TerminateEmployeeDto {
  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  effectiveDate!: string;

  @ApiProperty()
  @IsString()
  @Length(3, 300)
  reason!: string;
}

export class CreateContractDto {
  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES)
  kind!: (typeof EMPLOYMENT_TYPES)[number];

  @ApiProperty({ example: '2027-01-01' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: 'Required for pkwt, forbidden for pkwtt (BR-EMP-007)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  fileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateContractDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  fileId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class FamilyMemberDto {
  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty({ enum: RELATIONSHIPS })
  @IsIn(RELATIONSHIPS)
  relationship!: (typeof RELATIONSHIPS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PHONE)
  phone?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isEmergencyContact?: boolean;
}

export class UpdateFamilyMemberDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional({ enum: RELATIONSHIPS })
  @IsOptional()
  @IsIn(RELATIONSHIPS)
  relationship?: (typeof RELATIONSHIPS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  birthDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PHONE)
  phone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEmergencyContact?: boolean;
}
