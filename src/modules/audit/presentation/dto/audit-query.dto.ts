import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * §8's shape rules, and only those. The pair rule (`from < to`) and the
 * ≤-yesterday rule on `day` need a second field or a clock, so they live in the
 * use cases — a DTO that reached for either would be doing business validation
 * in the transport layer (backend-nestjs §6).
 */
export class AuditLogQueryDto {
  @ApiPropertyOptional({ description: 'Opaque keyset position; clients never build one' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, description: 'ADR-0007: default 20, max 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Timeline filter — pair with entityId' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ description: 'Prefix match — `leave.` reads a module’s whole trail' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  action?: string;

  @ApiPropertyOptional({ enum: ['user', 'system', 'platform_op'] })
  @IsOptional()
  @IsIn(['user', 'system', 'platform_op'])
  actorType?: 'user' | 'system' | 'platform_op';

  @ApiPropertyOptional({ description: 'Inclusive bound of `[from, to)`' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive bound of `[from, to)`' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
