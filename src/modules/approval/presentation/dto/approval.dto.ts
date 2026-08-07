import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import { REQUEST_TYPES } from '../../domain/request-types';

/**
 * §8's wire half. The division of labour is the one employee's DTOs state: the
 * DTO rejects **garbage** — a missing name, a negative priority, an unknown
 * request type — and the service rejects **rule violations** — a resolver
 * naming a deleted position, a chain that would leave a type without a
 * catch-all.
 *
 * `steps` and `conditions` are typed `unknown[]` here on purpose. Their legal
 * shape depends on a sibling field and on a tenant setting, so a nested DTO
 * would either duplicate `step-config.ts` or contradict it, and a decorator that
 * says less than the validator behind it is worse than no decorator at all.
 */
export class CreateChainDto {
  @ApiProperty({ enum: REQUEST_TYPES })
  @IsIn(REQUEST_TYPES)
  requestType!: string;

  @ApiPropertyOptional({ description: 'NULL = tenant-wide' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiProperty({ minLength: 3, maxLength: 80 })
  @IsString()
  @Length(3, 80)
  name!: string;

  @ApiPropertyOptional({ minimum: 1, default: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  conditions?: unknown[];

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  @IsArray()
  steps!: unknown[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Written as a sibling rather than a `PartialType(CreateChainDto)`: class
 * validator merges decorator metadata down the prototype chain, so an inherited
 * `@IsIn(REQUEST_TYPES)` would keep validating a field this endpoint does not
 * accept (`requestType` is not patchable — the conditions reference its context
 * fields). The employee module hit the same trap from the other direction.
 */
export class UpdateChainDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(3, 80)
  name?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  priority?: number;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  conditions?: unknown[];

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  steps?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateDelegationDto {
  @ApiPropertyOptional({ description: 'Admin form only; defaults to the caller' })
  @IsOptional()
  @IsUUID()
  delegatorUserId?: string;

  @ApiProperty()
  @IsUUID()
  delegateUserId!: string;

  @ApiPropertyOptional({ description: 'Omitted = every request type' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requestTypes?: string[];

  @ApiProperty({ example: '2026-03-01' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-03-14' })
  @IsDateString()
  endDate!: string;
}

/* ---------------------------------- reads ---------------------------------- */

/** api-standards §5.3 offset pagination, declared per module (organization's shape). */
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

export class ChainQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_TYPES })
  @IsOptional()
  @IsIn(REQUEST_TYPES)
  requestType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  companyId?: string;
}

const INSTANCE_STATUSES = ['in_progress', 'approved', 'rejected', 'returned', 'cancelled'] as const;
const SLA_STATES = ['reminded', 'escalated'] as const;

export class InstanceQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_TYPES })
  @IsOptional()
  @IsIn(REQUEST_TYPES)
  requestType?: string;

  @ApiPropertyOptional({ enum: INSTANCE_STATUSES })
  @IsOptional()
  @IsIn(INSTANCE_STATUSES)
  status?: (typeof INSTANCE_STATUSES)[number];

  @ApiPropertyOptional({ description: '`true` filters BR-APRV-006 stuck instances' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  stuck?: boolean;

  @ApiPropertyOptional({ enum: SLA_STATES })
  @IsOptional()
  @IsIn(SLA_STATES)
  slaState?: (typeof SLA_STATES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  companyId?: string;
}

export class DelegationQueryDto extends OffsetQueryDto {
  @ApiPropertyOptional({ description: 'Admin form only; own delegations otherwise' })
  @IsOptional()
  @IsUUID()
  delegatorUserId?: string;
}
