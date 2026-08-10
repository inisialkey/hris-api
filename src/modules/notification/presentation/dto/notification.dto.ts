import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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

import type { NotificationChannel } from '../../domain/notification.types';
import { TEMPLATES } from '../../domain/templates';

const CHANNELS: NotificationChannel[] = ['in_app', 'push', 'email'];
const TEMPLATE_KEYS = Object.keys(TEMPLATES);

export class FeedQueryDto {
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

  @ApiPropertyOptional({ description: 'Unread rows only' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
}

/**
 * §7: *"`{ read: true }` (the only mutable field; `false` unsupported — no
 * unread-restore)"*. `@Equals(true)` is §8's *"literal `true`"* rule, and it
 * lives here because it is a shape check with nothing to compare against.
 */
export class MarkReadDto {
  @ApiProperty({ enum: [true] })
  @IsBoolean()
  @Equals(true)
  read!: boolean;
}

/**
 * §7's single-cell toggle — the matrix saves per cell, so there is no bulk
 * shape and no partial-failure story to design.
 *
 * `templateKey` and `channel` are both checked twice, and deliberately: here for
 * shape (*"is this a registered key"*, *"is this a channel"*) and in the use case
 * for the rule the DTO cannot see (*"is this channel declared by **that**
 * template"*, and *"is that template mandatory"*).
 */
export class UpdatePreferenceDto {
  @ApiProperty({ enum: TEMPLATE_KEYS })
  @IsString()
  @IsIn(TEMPLATE_KEYS)
  templateKey!: string;

  @ApiProperty({ enum: CHANNELS })
  @IsIn(CHANNELS)
  channel!: NotificationChannel;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}
