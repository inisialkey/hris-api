import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import type { HolidayKind } from '../../domain/holiday.types';

const KINDS: readonly HolidayKind[] = ['national', 'cuti_bersama', 'custom'];

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

/** §8's query guard — a year outside this is a typo, not a calendar. */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

export class HolidayQueryDto extends OffsetQueryDto {
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(YEAR_MIN)
  @Max(YEAR_MAX)
  year!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsIn(KINDS)
  kind?: HolidayKind;
}

export class ResolvedQueryDto {
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(YEAR_MIN)
  @Max(YEAR_MAX)
  year!: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Ignored for callers without the read key' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class SyncQueryDto {
  @ApiPropertyOptional({ description: 'Device high-water mark, ISO-8601 UTC' })
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;

  @ApiPropertyOptional({ description: 'Opaque keyset position' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateHolidayDto {
  @ApiProperty({ example: '2026-01-01' })
  @IsISO8601({ strict: true })
  date!: string;

  @ApiProperty({ example: 'Tahun Baru' })
  @IsString()
  @Length(2, 120)
  name!: string;

  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: HolidayKind;

  @ApiPropertyOptional({ format: 'uuid', description: 'Omit for a tenant-wide row' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Requires companyId (BR-HOL-005)' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ default: true, description: 'false negates a broader-scope day' })
  @IsOptional()
  @IsBoolean()
  observed?: boolean;
}

/** `kind` and scope are identity — §7 says recreate rather than move them. */
export class UpdateHolidayDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional({ example: '2026-01-02' })
  @IsOptional()
  @IsISO8601({ strict: true })
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  observed?: boolean;
}
