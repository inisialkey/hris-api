import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
}
