import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class DefinitionQueryDto {
  @ApiPropertyOptional({ description: 'Namespace filter — the editor groups by it' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  module?: string;
}

export class ValueQueryDto {
  @ApiProperty({ description: 'Required: history is per key, never a whole-tenant dump' })
  @IsString()
  @MaxLength(120)
  key!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

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

/**
 * §7's POST body. The `value` field is deliberately untyped here: its type is
 * whatever the definition says, and a DTO cannot know which key is coming.
 * `validateValue` is where the type is checked, against the registry — which is
 * the only place that knows the answer (backend-nestjs §6).
 */
export class WriteValueDto {
  @ApiProperty({ example: 'attendance.geofence_radius_m' })
  @IsString()
  @MaxLength(120)
  key!: string;

  @ApiProperty({ enum: ['tenant', 'company', 'branch'] })
  @IsIn(['tenant', 'company', 'branch'])
  level!: 'tenant' | 'company' | 'branch';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required at company and branch level' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Required at branch level' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  // `@IsDefined` and nothing else: `false`, `0` and `''` are all legitimate
  // setting values, so anything that treated falsiness as absence would reject
  // three of them.
  @ApiProperty({ description: 'Typed per the definition; decimals as strings' })
  @IsDefined()
  value!: unknown;

  @ApiPropertyOptional({
    description: 'Defaults to today; a later date schedules (dated keys only)',
  })
  @IsOptional()
  @Matches(ISO_DAY)
  effectiveFrom?: string;
}
