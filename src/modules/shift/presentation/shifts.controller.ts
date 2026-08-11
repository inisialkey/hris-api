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
import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { PatternService } from '../application/pattern.service';
import { ShiftDefinitionService } from '../application/shift-definition.service';
import {
  CreatePatternDto,
  CreateShiftDto,
  ShiftQueryDto,
  UpdatePatternDto,
  UpdateShiftDto,
} from './dto/shift.dto';

/** §7's shift-definition endpoints. */
@ApiTags('shift')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftDefinitionService) {}

  @Get()
  @RequirePermission('shift.definition.read')
  @ApiOperation({ operationId: 'listShifts', summary: 'Shifts of a company, with usage counts' })
  async list(@Query() query: ShiftQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.shifts.list(
        { companyId: query.companyId, q: query.q },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );
    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Post()
  @RequirePermission('shift.definition.configure')
  @ApiOperation({ operationId: 'createShift', summary: 'Define a working-time window' })
  async create(@Body() dto: CreateShiftDto) {
    return unwrap(
      await this.shifts.create({
        companyId: dto.companyId,
        code: dto.code,
        name: dto.name,
        startTime: dto.startTime,
        endTime: dto.endTime,
        breakMinutes: dto.breakMinutes ?? 0,
        breakStartTime: dto.breakStartTime ?? null,
        lateToleranceMinutes: dto.lateToleranceMinutes ?? 0,
        earlyLeaveToleranceMinutes: dto.earlyLeaveToleranceMinutes ?? 0,
        punchInBeforeMinutes: dto.punchInBeforeMinutes ?? 60,
        punchOutAfterMinutes: dto.punchOutAfterMinutes ?? 60,
        color: dto.color ?? null,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('shift.definition.configure')
  @ApiOperation({ operationId: 'updateShift', summary: 'Edit times, tolerances or window' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateShiftDto) {
    return unwrap(await this.shifts.update(id, dto));
  }

  @Delete(':id')
  @RequirePermission('shift.definition.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveShift', summary: 'Archive, blocked by live dependents' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.shifts.archive(id));
  }
}

/** §7's pattern endpoints — the cycle strip, saved as a replace-all. */
@ApiTags('shift')
@Controller('shift-patterns')
export class ShiftPatternsController {
  constructor(private readonly patterns: PatternService) {}

  @Get()
  @RequirePermission('shift.definition.read')
  @ApiOperation({ operationId: 'listShiftPatterns', summary: 'Patterns of a company' })
  async list(@Query() query: ShiftQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.patterns.list(
        { companyId: query.companyId, q: query.q },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );
    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Get(':id')
  @RequirePermission('shift.definition.read')
  @ApiOperation({ operationId: 'getShiftPattern', summary: 'One pattern with its cycle' })
  async find(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.patterns.find(id));
  }

  @Post()
  @RequirePermission('shift.definition.configure')
  @ApiOperation({ operationId: 'createShiftPattern', summary: 'Build a repeating cycle' })
  async create(@Body() dto: CreatePatternDto) {
    return unwrap(
      await this.patterns.create({
        companyId: dto.companyId,
        code: dto.code,
        name: dto.name,
        cycleLength: dto.cycleLength,
        observesHolidays: dto.observesHolidays ?? true,
        days: dto.days.map((day) => ({ dayIndex: day.dayIndex, shiftId: day.shiftId ?? null })),
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('shift.definition.configure')
  @ApiOperation({ operationId: 'updateShiftPattern', summary: 'Edit the cycle or its policy' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePatternDto) {
    return unwrap(
      await this.patterns.update(id, {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.observesHolidays === undefined ? {} : { observesHolidays: dto.observesHolidays }),
        ...(dto.cycleLength === undefined ? {} : { cycleLength: dto.cycleLength }),
        ...(dto.days === undefined
          ? {}
          : {
              days: dto.days.map((day) => ({
                dayIndex: day.dayIndex,
                shiftId: day.shiftId ?? null,
              })),
            }),
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('shift.definition.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveShiftPattern', summary: 'Archive, blocked by assignments' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.patterns.archive(id));
  }
}

export function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
