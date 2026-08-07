import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { CATEGORY_POLICIES } from '../../domain/categories';

const CATEGORY_KEYS = Object.keys(CATEGORY_POLICIES);

/**
 * §8's wire half. The division of labour is the one every module here draws: the
 * DTO rejects **garbage** — a missing name, a zero size, a category outside the
 * registry — and the use case rejects **rule violations**, which for this module
 * means the mime whitelist (`DOC_TYPE_NOT_ALLOWED`) and the effective cap
 * (`DOC_SIZE_EXCEEDED`). §8 says so in as many words: *"whitelist is business"*,
 * *"cap is business"*.
 *
 * `fileName` is bounded and never rejected for content: §8 makes sanitation
 * server-side and explicitly not a rejection.
 */
export class CreateUploadSlotDto {
  @ApiProperty({ enum: CATEGORY_KEYS })
  @IsString()
  @Length(1, 64)
  category!: string;

  @ApiProperty({ description: 'Polymorphic owner — resolver-verified' })
  @IsString()
  @Length(1, 64)
  entityType!: string;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @Length(1, 255)
  fileName!: string;

  @ApiProperty({ description: 'Declared media type; verified against magic bytes at confirm' })
  @IsString()
  @Length(1, 128)
  mime!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

/** §7: *"Request: `{}` (identity is the resource)"*. */
export class ConfirmUploadDto {}

export class ListDocumentsQueryDto {
  @ApiProperty()
  @IsString()
  @Length(1, 64)
  entityType!: string;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
