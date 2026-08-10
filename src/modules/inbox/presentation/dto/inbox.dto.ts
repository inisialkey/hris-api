import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { InboxItemStatus, InboxItemType } from '../../domain/inbox.types';

const TYPES: InboxItemType[] = ['approval_task', 'acknowledgment'];
const STATUSES: InboxItemStatus[] = ['open', 'done', 'closed'];

/**
 * §8's three filter rules. `type` and `status` are `VAL_INVALID_ENUM` here
 * rather than in a use case, because a filter value that is not in the enum
 * cannot mean anything downstream — coding-standards-nestjs §1's *"wire input
 * enums validated by `@IsIn` at the edge; past the DTO, values are trusted and
 * closed"*.
 */
export class InboxQueryDto {
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

  @ApiPropertyOptional({ enum: TYPES })
  @IsOptional()
  @IsIn(TYPES)
  type?: InboxItemType;

  @ApiPropertyOptional({ enum: STATUSES, default: 'open', description: '§7 defaults to open' })
  @IsOptional()
  @IsIn(STATUSES)
  status?: InboxItemStatus;
}

/**
 * §7: *"`{ seen: true }` (only mutable field here; no unsee)"*, and §8's
 * *"literal `true`"* rule. A shape check with nothing to compare against, so it
 * belongs in the DTO rather than in the use case.
 */
export class MarkSeenDto {
  @ApiProperty({ enum: [true] })
  @IsBoolean()
  @Equals(true)
  seen!: boolean;
}
