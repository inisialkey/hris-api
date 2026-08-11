import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { OffsetMeta } from '../../../shared/envelope';
import { decodeCursor, encodeCursor } from '../../../shared/http/cursor';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, RequirePermission } from '../../authz';
import { HolidayService } from '../application/holiday.service';
import type { HolidayRow } from '../domain/holiday.types';
import {
  CreateHolidayDto,
  HolidayQueryDto,
  ResolvedQueryDto,
  SyncQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';

/**
 * §7's six endpoints. Two are `@AuthenticatedOnly()` — the resolved calendar and
 * the device mirror — because both answer "my scope", which is data scope rather
 * than a permission (ADR-0005's second axis).
 */
@ApiTags('holiday')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidayService) {}

  @Get()
  @RequirePermission('holiday.calendar.read')
  @ApiOperation({ operationId: 'listHolidays', summary: 'Raw calendar rows for a year' })
  async list(@Query() query: HolidayQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.holidays.list(
        {
          year: query.year,
          companyId: query.companyId,
          branchId: query.branchId,
          kind: query.kind,
        },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );

    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  /**
   * The effective calendar, BR-HOL-002 applied. Declared before `:id` routes
   * exist here for the same reason it would be needed if they did — a literal
   * segment that a parameter could swallow is a bug waiting for the next endpoint.
   */
  @Get('resolved')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'resolveHolidays', summary: 'Effective calendar for a scope' })
  async resolved(@Query() query: ResolvedQueryDto) {
    const resolved = unwrap(
      await this.holidays.resolved(query.year, {
        companyId: query.companyId ?? null,
        branchId: query.branchId ?? null,
      }),
    );

    return {
      data: resolved.days,
      meta: {
        year: query.year,
        companyId: resolved.scope.companyId,
        branchId: resolved.scope.branchId,
      },
    };
  }

  /** api-standards §8's delta shape. Tombstones ride along; the device evicts on them. */
  @Get('sync')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'syncHolidays', summary: 'Delta sync for the device mirror' })
  async sync(@Query() query: SyncQueryDto) {
    const limit = query.limit ?? 20;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const page = unwrap(
      await this.holidays.sync(
        query.updatedSince ? new Date(query.updatedSince) : null,
        cursor ? { id: cursor.id } : null,
        limit,
      ),
    );

    const last = page.rows.at(-1);
    return {
      data: page.rows.map(toSyncRow),
      meta: {
        nextCursor:
          page.hasMore && last
            ? encodeCursor({ occurredAt: last.updatedAt.toISOString(), id: last.id })
            : null,
        hasMore: page.hasMore,
      },
    };
  }

  @Post()
  @RequirePermission('holiday.calendar.configure')
  @ApiOperation({ operationId: 'createHoliday', summary: 'Add or negate a day at a scope' })
  async create(@Body() dto: CreateHolidayDto) {
    return unwrap(
      await this.holidays.create({
        date: dto.date,
        name: dto.name,
        kind: dto.kind,
        companyId: dto.companyId ?? null,
        branchId: dto.branchId ?? null,
        observed: dto.observed ?? true,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('holiday.calendar.configure')
  @ApiOperation({ operationId: 'updateHoliday', summary: 'Edit name, date or observation' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHolidayDto) {
    return unwrap(await this.holidays.update(id, dto));
  }

  @Delete(':id')
  @RequirePermission('holiday.calendar.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteHoliday', summary: 'Soft delete; tombstoned for sync' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.holidays.remove(id));
  }
}

/** The device mirrors raw rows and resolves locally (BR-HOL-010), tombstones included. */
function toSyncRow(row: HolidayRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    branchId: row.branchId,
    date: row.date,
    name: row.name,
    kind: row.kind,
    observed: row.observed,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
