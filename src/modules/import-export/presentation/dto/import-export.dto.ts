import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { ExportJobStatus, ImportJobStatus } from '../../domain/import-export.types';

const IMPORT_STATUSES: ImportJobStatus[] = [
  'uploaded',
  'validating',
  'awaiting_confirmation',
  'committing',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
];

const EXPORT_STATUSES: ExportJobStatus[] = ['queued', 'running', 'completed', 'failed'];

/**
 * §8's `type` row is *"registered definition key"* and that check is **not**
 * here: the registry is runtime state and existence hiding decides the answer
 * (`DefinitionAccessService`). What the DTO enforces is shape — a string, and a
 * bounded one, so a megabyte of `type` never reaches a `Map.get`.
 */
class DefinitionKeyDto {
  @ApiProperty({ example: 'employee.master' })
  @IsString()
  @MaxLength(120)
  type!: string;
}

export class StartImportDto extends DefinitionKeyDto {
  @ApiProperty({ format: 'uuid', description: 'Committed `import_file` uploaded by the caller' })
  @IsUUID()
  fileId!: string;
}

export class TemplateQueryDto extends DefinitionKeyDto {}

export class CreateExportDto extends DefinitionKeyDto {
  /**
   * Validated against the definition's `ParamSpec` in the use case, not here:
   * the rules are a property of the `type` in the same body, which no decorator
   * can reach. `@IsObject` is the shape floor that keeps a string or an array
   * out of `Object.keys`.
   */
  @ApiProperty({ type: Object, example: { companyId: '…', from: '2026-01-01', to: '2026-01-31' } })
  @IsObject()
  params!: Record<string, unknown>;
}

/** ADR-0007's offset family — the admin-grid style api-standards §6 registers for job lists. */
class JobListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, description: 'ADR-0007: default 20, max 100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  type?: string;
}

export class ListImportsQueryDto extends JobListQueryDto {
  @ApiPropertyOptional({ enum: IMPORT_STATUSES })
  @IsOptional()
  @IsIn(IMPORT_STATUSES)
  status?: ImportJobStatus;
}

export class ListExportsQueryDto extends JobListQueryDto {
  @ApiPropertyOptional({ enum: EXPORT_STATUSES })
  @IsOptional()
  @IsIn(EXPORT_STATUSES)
  status?: ExportJobStatus;
}
