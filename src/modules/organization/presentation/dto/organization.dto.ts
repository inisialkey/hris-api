import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { INDONESIAN_TIMEZONES } from '../../application/branch.service';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** §8: 2–20, `[A-Z0-9-]`, unique per scope. One expression, five entities. */
const CODE = /^[A-Z0-9-]{2,20}$/;

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

/* --------------------------------- companies -------------------------------- */

export class CompanyQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ description: 'Matches code or name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class CreateCompanyDto {
  @ApiProperty({ example: 'HO' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiPropertyOptional({ description: 'PT ... as registered' })
  @IsOptional()
  @IsString()
  @Length(2, 200)
  legalName?: string;

  @ApiPropertyOptional({ description: 'Corporate tax id, 15–16 digits' })
  @IsOptional()
  @Matches(/^\d{15,16}$/)
  npwp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/** `code` is identity and is not editable — §7 says so for every entity here. */
export class UpdateCompanyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{15,16}$/)
  npwp?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/* --------------------------------- branches --------------------------------- */

export class BranchQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Required — branches are read per company' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class CreateBranchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ example: 'JKT' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty({ enum: INDONESIAN_TIMEZONES })
  @IsIn([...INDONESIAN_TIMEZONES])
  timezone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  // Sent as numbers, stored as `numeric` strings: a geofence centre is a decimal
  // and `parseFloat` on one is a lint error for the same reason it is on money.
  @ApiPropertyOptional({ description: 'Paired with longitude — both or neither' })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({ description: 'Paired with latitude — both or neither' })
  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

export class UpdateBranchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional({ enum: INDONESIAN_TIMEZONES })
  @IsOptional()
  @IsIn([...INDONESIAN_TIMEZONES])
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;
}

/* -------------------------------- departments ------------------------------- */

export class DepartmentQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional({ description: 'The full nested forest instead of a page' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  tree?: boolean;
}

export class CreateDepartmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Omit for a top-level department' })
  @IsOptional()
  @IsUUID()
  parentDepartmentId?: string;

  @ApiProperty({ example: 'FIN' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;
}

export class UpdateDepartmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  // `null` re-parents to the top, which is why this is not merely optional: an
  // absent field means "leave it alone" and an explicit null means "detach".
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID(undefined, { each: false })
  parentDepartmentId?: string | null;
}

/* -------------------------------- job levels -------------------------------- */

export class CreateJobLevelDto {
  @ApiProperty({ example: 'L3' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty({ description: 'Ordering only; ties are legal (parallel bands)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rank!: number;
}

export class UpdateJobLevelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rank?: number;
}

/* --------------------------------- positions -------------------------------- */

export class PositionQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobLevelId?: string;

  @ApiPropertyOptional({ description: 'Seats with no live holder on the date' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  vacant?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class CreatePositionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  departmentId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  jobLevelId!: string;

  @ApiProperty({ example: 'FIN-MGR' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  title!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Omit for the top of a reporting tree' })
  @IsOptional()
  @IsUUID()
  reportsToPositionId?: string;
}

export class UpdatePositionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  title?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobLevelId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  reportsToPositionId?: string | null;
}

/* ----------------------------------- chart ---------------------------------- */

export class ChartQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Admins: any in scope. Others: forced own' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Load one subtree instead of the forest' })
  @IsOptional()
  @IsUUID()
  rootPositionId?: string;

  @ApiPropertyOptional({ description: 'Levels below the root; default full' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  depth?: number;
}

/* -------------------------------- assignments ------------------------------- */

/**
 * §7: `hire` is **port-only**. It is seeded by employee.md inside the hire
 * transaction (BR-ORG-002), and accepting it over HTTP would let an admin
 * manufacture a second first-day placement for someone already employed.
 */
export const HTTP_ASSIGNMENT_KINDS = ['transfer', 'promotion', 'correction'] as const;

export class CreateAssignmentDto {
  @ApiProperty({ format: 'uuid', description: "The employee's company (BR-ORG-002)" })
  @IsUUID()
  positionId!: string;

  @ApiProperty({ format: 'uuid', description: "The employee's company (BR-ORG-002)" })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ description: '≥ join date, > current row’s from, outside a locked period' })
  @Matches(ISO_DAY)
  effectiveFrom!: string;

  @ApiProperty({ enum: HTTP_ASSIGNMENT_KINDS })
  @IsIn([...HTTP_ASSIGNMENT_KINDS])
  kind!: (typeof HTTP_ASSIGNMENT_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
