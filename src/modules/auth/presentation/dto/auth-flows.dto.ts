import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Transport shapes for the §7 endpoints beyond login. Same discipline as
 * `LoginDto`: garbage is rejected here, truth is the use case's business.
 */

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Mobile: the token. Web: absent — the cookie rides.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;

  @ApiPropertyOptional({ description: 'Rides when FCM rotated it since the last report (§7)' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fcmToken?: string;
}

/** `?userId=` needs `auth.session.read` / `auth.device.read`; offset params per api-standards §6. */
export class OwnerListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

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

export class ResetRequestDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetConfirmDto {
  // Opaque — validity is a business check, not a format (§8).
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  token!: string;

  @ApiProperty({ description: 'Transport floor 10–128; tenant policy tightens above (§8)' })
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword!: string;
}

export class ChangePasswordDto {
  // Same rules as the login password: never trimmed, no minimum — the check is
  // a verify, and a transport minimum would leak stored-password length class.
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword!: string;
}

export class InviteAcceptDto {
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  token!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password!: string;
}
