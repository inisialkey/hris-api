import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { OffsetMeta } from '../../../shared/envelope';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, RequirePermission } from '../../authz';
import { DefinitionQueryService } from '../application/definition-query.service';
import { ExportService } from '../application/export.service';
import { ImportJobsService } from '../application/import-jobs.service';
import type { ExportJobRow, ImportJobRow, Paged } from '../domain/import-export.types';
import { XLSX_MIME } from '../infrastructure/workbook-layout';
import {
  CreateExportDto,
  ListExportsQueryDto,
  ListImportsQueryDto,
  StartImportDto,
  TemplateQueryDto,
} from './dto/import-export.dto';

/** §7's job-list gate — the one static key in this controller. */
const JOB_READ = 'import-export.job.read';

/**
 * §7's ten endpoints, and they split into two gates.
 *
 * The three list/detail routes carry `@RequirePermission('import-export.job.read')`,
 * because §2 makes that a real key over the jobs pages: *"jobs are tenant
 * artifacts, not personal drafts"*, so anybody with the key sees every job row.
 *
 * The other seven are `@AuthenticatedOnly()` and the gate runs inside, which is
 * document-storage §2's **documented deviation** applied for the identical
 * structural reason: the required key is a property of the `type` in the
 * request. `POST /imports` needs `employee.master.import` for one body and
 * `holiday.calendar.import` for the next, and no decorator can be both. The
 * route lint accepts the explicit marker; `DefinitionAccessService` is the
 * check, and it answers `VAL_INVALID_ENUM` rather than 403 so that an unrunnable
 * definition stays as invisible as §7 makes it in `GET /definitions`.
 */
@ApiTags('import-export')
@Controller('import-export')
export class ImportExportController {
  constructor(
    private readonly definitions: DefinitionQueryService,
    private readonly imports: ImportJobsService,
    private readonly exports: ExportService,
  ) {}

  @Get('definitions')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'listImportExportDefinitions',
    summary: 'Definitions the caller may run — existence hiding applies',
  })
  async catalog() {
    return this.definitions.catalog();
  }

  /**
   * Declared **before** `@Get('imports/:id')`. Nest matches routes in
   * declaration order, so a `:id` pattern above this one swallows the literal
   * and hands `"template"` to `ParseUUIDPipe` — a 422 on a route that exists.
   *
   * BR-IMP-012's one sanctioned synchronous file response, which is also why
   * this is the only handler in the module taking `@Res()`: the envelope has no
   * shape for a byte stream, and the workbook is written straight into the
   * response rather than buffered into one.
   */
  @Get('imports/template')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'downloadImportTemplate', summary: 'UC-IMP-005 — BR-IMP-012' })
  async template(@Query() query: TemplateQueryDto, @Res() response: Response) {
    // Gate, then headers, then bytes — in that order and not another. A stream
    // commits its status with the first byte, so a refusal decided halfway
    // through would arrive as a 200 with a truncated workbook.
    const definition = unwrap(await this.definitions.definitionFor(query.type));
    response.setHeader('Content-Type', XLSX_MIME);
    // The name is built from the definition key, which the registry vouches for
    // — never from the raw query string, which would put a caller's text into a
    // response header.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${definition.key}-template-v${definition.templateVersion}.xlsx"`,
    );
    await this.definitions.writeTemplate(definition, response);
  }

  @Post('imports')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'startImport', summary: 'UC-IMP-001' })
  async start(@Body() dto: StartImportDto) {
    return toImportRow(unwrap(await this.imports.start(dto.type, dto.fileId)));
  }

  @Get('imports')
  @RequirePermission(JOB_READ)
  @ApiOperation({ operationId: 'listImportJobs', summary: 'Jobs page — offset (api-standards §6)' })
  async listImports(@Query() query: ListImportsQueryDto) {
    const page = pageOf(query);
    const found = await this.imports.list({ type: query.type, status: query.status }, page.slice);
    return paged(found, page, toImportRow);
  }

  @Get('imports/:id')
  @RequirePermission(JOB_READ)
  @ApiOperation({ operationId: 'getImportJob', summary: '§7 — the polling contract' })
  async findImport(@Param('id', ParseUUIDPipe) id: string) {
    return toImportRow(unwrap(await this.imports.find(id)));
  }

  @Post('imports/:id/confirm')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'confirmImport', summary: 'UC-IMP-003 — any permission holder' })
  async confirm(@Param('id', ParseUUIDPipe) id: string) {
    return toImportRow(unwrap(await this.imports.confirm(id)));
  }

  @Post('imports/:id/cancel')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'cancelImport', summary: 'UC-IMP-004 — awaiting_confirmation only' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return toImportRow(unwrap(await this.imports.cancel(id)));
  }

  @Post('exports')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'startExport', summary: 'UC-IMP-006 — always async (ADR-0015)' })
  async startExport(@Body() dto: CreateExportDto) {
    return toExportRow(unwrap(await this.exports.enqueue(dto.type, dto.params)));
  }

  @Get('exports')
  @RequirePermission(JOB_READ)
  @ApiOperation({ operationId: 'listExportJobs', summary: 'Jobs page — offset' })
  async listExports(@Query() query: ListExportsQueryDto) {
    const page = pageOf(query);
    const found = await this.exports.list({ type: query.type, status: query.status }, page.slice);
    return paged(found, page, toExportRow);
  }

  @Get('exports/:id')
  @RequirePermission(JOB_READ)
  @ApiOperation({ operationId: 'getExportJob', summary: '§7 — the polling contract' })
  async findExport(@Param('id', ParseUUIDPipe) id: string) {
    return toExportRow(unwrap(await this.exports.find(id)));
  }
}

function pageOf(query: { page?: number; pageSize?: number }) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  return { page, pageSize, slice: { limit: pageSize, offset: (page - 1) * pageSize } };
}

function paged<T, W>(
  found: Paged<T>,
  page: { page: number; pageSize: number },
  map: (row: T) => W,
): { data: W[]; meta: OffsetMeta } {
  return {
    data: found.rows.map(map),
    meta: {
      page: page.page,
      pageSize: page.pageSize,
      totalItems: found.total,
      totalPages: Math.ceil(found.total / page.pageSize),
    },
  };
}

/** §7's import job row, verbatim — the shape the wizard polls. */
function toImportRow(job: ImportJobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    appliedRows: job.appliedRows,
    templateVersion: job.templateVersion,
    fileId: job.fileId,
    errorReportFileId: job.errorReportFileId,
    failureCode: job.failureCode,
    requestedBy: job.requestedBy,
    confirmedBy: job.confirmedBy,
    createdAt: job.createdAt.toISOString(),
    confirmedAt: job.confirmedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

/**
 * §7's export job row. `params` goes out whole, including the `_columns` and
 * `_gated` keys UC-IMP-006 freezes into it — the wizard needs to know which
 * columns the file it is waiting for will carry, and hiding them would mean
 * storing the entitlement somewhere the contract does not describe.
 */
function toExportRow(job: ExportJobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    params: job.params,
    fileId: job.fileId,
    rowCount: job.rowCount,
    failureCode: job.failureCode,
    requestedBy: job.requestedBy,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
