import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** §8: 1–20, `[A-Z0-9-]`. `OFF` is refused by the service — it is a sentinel, not a code. */
const CODE = /^[A-Z0-9-]{1,20}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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

/* ---------------------------------- shifts --------------------------------- */

export class ShiftQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional({ description: 'Matches code or name' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;
}

export class CreateShiftDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ example: 'OFFICE' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ example: '08:00' })
  @Matches(TIME)
  startTime!: string;

  @ApiProperty({ example: '17:00', description: 'Earlier than start means it crosses midnight' })
  @Matches(TIME)
  endTime!: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @ApiPropertyOptional({ example: '12:00' })
  @IsOptional()
  @Matches(TIME)
  breakStartTime?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  lateToleranceMinutes?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  earlyLeaveToleranceMinutes?: number;

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(720)
  punchInBeforeMinutes?: number;

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(720)
  punchOutAfterMinutes?: number;

  @ApiPropertyOptional({ description: 'design-system palette token key' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  color?: string;
}

/** `companyId` and `code` are identity — §7 says they are not patchable. */
export class UpdateShiftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ example: '08:30' })
  @IsOptional()
  @Matches(TIME)
  startTime?: string;

  @ApiPropertyOptional({ example: '17:30' })
  @IsOptional()
  @Matches(TIME)
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  breakMinutes?: number;

  @ApiPropertyOptional({ example: '12:00' })
  @IsOptional()
  @Matches(TIME)
  breakStartTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  lateToleranceMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  earlyLeaveToleranceMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(720)
  punchInBeforeMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(720)
  punchOutAfterMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  color?: string;
}

/* --------------------------------- patterns -------------------------------- */

export class PatternDayDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  dayIndex!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'null = an OFF entry' })
  @IsOptional()
  @IsUUID()
  shiftId?: string | null;
}

export class CreatePatternDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ example: '5-2' })
  @Matches(CODE)
  code!: string;

  @ApiProperty()
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiProperty({ example: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  cycleLength!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  observesHolidays?: boolean;

  @ApiProperty({ type: [PatternDayDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => PatternDayDto)
  days!: PatternDayDto[];
}

export class UpdatePatternDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  observesHolidays?: boolean;

  @ApiPropertyOptional({ description: 'Changing this requires a full `days` array' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  cycleLength?: number;

  @ApiPropertyOptional({ type: [PatternDayDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => PatternDayDto)
  days?: PatternDayDto[];
}

/* ------------------------------- assignments ------------------------------- */

export class AssignmentQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Ask for the company default arrangement instead' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  companyDefault?: boolean;
}

export class CreateAssignmentDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Omit for the company-default row' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patternId!: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @ApiPropertyOptional({ description: 'Defaults to effectiveFrom; the cycle’s phase' })
  @IsOptional()
  @IsISO8601({ strict: true })
  cycleAnchorDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class BulkAssignDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  employeeIds!: string[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patternId!: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsISO8601({ strict: true })
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  cycleAnchorDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 300)
  note?: string;
}

/* ------------------------------- roster days ------------------------------- */

export class GridQueryDto extends OffsetQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  companyId!: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsISO8601({ strict: true })
  from!: string;

  @ApiProperty({ example: '2026-10-01', description: 'Exclusive; span ≤ 62 days' })
  @IsISO8601({ strict: true })
  to!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ description: 'Matches employee name or number' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  q?: string;
}

export class PaintItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ example: '2026-09-14' })
  @IsISO8601({ strict: true })
  date!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'null = an explicit day off' })
  @IsOptional()
  @IsUUID()
  shiftId?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  worksOnHoliday?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 300)
  note?: string;
}

export class PaintRosterDaysDto {
  @ApiProperty({ type: [PaintItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PaintItemDto)
  items!: PaintItemDto[];
}

/* ----------------------------------- me ------------------------------------ */

export class MyScheduleQueryDto {
  @ApiPropertyOptional({ description: 'Clamped to the platform window (BR-SHF-014)' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class TeamScheduleQueryDto {
  @ApiProperty({ example: '2026-09-14' })
  @IsISO8601({ strict: true })
  date!: string;
}
