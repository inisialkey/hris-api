import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** `device` object of §7 — mobile-required, web-absent. */
export class LoginDeviceDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated per install (ADR-0004)' })
  @IsUUID()
  installId!: string;

  @ApiProperty({ enum: ['android', 'ios'] })
  @IsIn(['android', 'ios'])
  platform!: 'android' | 'ios';

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  model!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  osVersion!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  appVersion!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fcmToken?: string;
}

/**
 * Transport validation only (authentication.md §8, backend-nestjs §6). This DTO
 * rejects **garbage**; whether the credential is right is the use case's answer,
 * and the two must never be merged — a DTO that knew about accounts would leak
 * their existence through a 422.
 */
export class LoginDto {
  @ApiProperty({ example: 'admin@tenant-one.test' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Never trimmed, and no minimum: a login must not tell an attacker that the
  // stored password is longer than what they typed. 128 is the DoS guard —
  // argon2 itself has no input cap (security-standards §2).
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Second call, after the tenant picker' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Web only; drives refresh lifetime (ADR-0004)' })
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;

  @ApiPropertyOptional({ type: LoginDeviceDto, description: 'Mobile required; absent = web' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LoginDeviceDto)
  device?: LoginDeviceDto;

  @ApiPropertyOptional({ format: 'uuid', description: 'Self-service replacement (BR-AUTH-007)' })
  @IsOptional()
  @IsUUID()
  replaceDeviceId?: string;
}
