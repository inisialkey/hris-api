import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, RequirePermission } from '../../authz';
import { MyScheduleService } from '../application/me-schedule.service';
import { RosterAssignmentService } from '../application/roster-assignment.service';
import { RosterDayService } from '../application/roster-day.service';
import { RosterGridService } from '../application/roster-grid.service';
import {
  AssignmentQueryDto,
  BulkAssignDto,
  CreateAssignmentDto,
  GridQueryDto,
  MyScheduleQueryDto,
  PaintRosterDaysDto,
  TeamScheduleQueryDto,
} from './dto/shift.dto';
import { offsetMeta } from './shifts.controller';

/** §7's roster-assignment endpoints — who runs which pattern, from when. */
@ApiTags('shift')
@Controller('roster-assignments')
export class RosterAssignmentsController {
  constructor(private readonly assignments: RosterAssignmentService) {}

  @Get()
  @RequirePermission('shift.roster.read')
  @ApiOperation({ operationId: 'listRosterAssignments', summary: 'Arrangement history' })
  async history(@Query() query: AssignmentQueryDto) {
    const rows = unwrap(
      await this.assignments.history({
        companyId: query.companyId,
        employeeId: query.employeeId,
        companyDefault: query.companyDefault,
      }),
    );
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      meta: offsetMeta(page, pageSize, rows.length),
    };
  }

  @Post()
  @RequirePermission('shift.roster.assign')
  @ApiOperation({ operationId: 'assignRosterPattern', summary: 'Assign a pattern, superseding' })
  async assign(@Body() dto: CreateAssignmentDto) {
    return unwrap(
      await this.assignments.assign({
        employeeId: dto.employeeId ?? null,
        companyId: dto.companyId,
        patternId: dto.patternId,
        effectiveFrom: dto.effectiveFrom,
        ...(dto.cycleAnchorDate === undefined ? {} : { cycleAnchorDate: dto.cycleAnchorDate }),
        note: dto.note ?? null,
      }),
    );
  }

  @Post('bulk-assign')
  @RequirePermission('shift.roster.assign')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'bulkAssignRosterPattern',
    summary: 'Assign many, per-item results',
  })
  async bulkAssign(@Body() dto: BulkAssignDto) {
    const results = unwrap(
      await this.assignments.bulkAssign({
        employeeIds: dto.employeeIds,
        companyId: dto.companyId,
        patternId: dto.patternId,
        effectiveFrom: dto.effectiveFrom,
        ...(dto.cycleAnchorDate === undefined ? {} : { cycleAnchorDate: dto.cycleAnchorDate }),
        note: dto.note ?? null,
      }),
    );
    return { data: { results }, meta: summarize(results) };
  }

  @Delete(':id')
  @RequirePermission('shift.roster.assign')
  @HttpCode(200)
  @ApiOperation({ operationId: 'cancelRosterAssignment', summary: 'Cancel a scheduled assignment' })
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.assignments.cancel(id));
  }
}

/** §7's roster-day endpoints — the grid read and the cell writes. */
@ApiTags('shift')
@Controller('roster-days')
export class RosterDaysController {
  constructor(
    private readonly grid: RosterGridService,
    private readonly rosterDays: RosterDayService,
  ) {}

  @Get('resolved')
  @RequirePermission('shift.roster.read')
  @ApiOperation({ operationId: 'resolveRoster', summary: 'The grid, resolution applied' })
  async resolved(@Query() query: GridQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const resolved = unwrap(
      await this.grid.resolved(
        {
          companyId: query.companyId,
          from: query.from,
          to: query.to,
          ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
          ...(query.departmentId === undefined ? {} : { departmentId: query.departmentId }),
          ...(query.employeeId === undefined ? {} : { employeeId: query.employeeId }),
          ...(query.q === undefined ? {} : { q: query.q }),
        },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );

    return {
      data: resolved.rows,
      meta: {
        ...offsetMeta(page, pageSize, resolved.total),
        from: query.from,
        to: query.to,
        lockedDates: resolved.lockedDates,
      },
    };
  }

  /**
   * Batched by **natural key** rather than by id — the deviation from
   * api-standards §10 that §7 declares, because the rows may not exist yet.
   */
  @Post('bulk-assign')
  @RequirePermission('shift.roster.assign')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'paintRosterDays',
    summary: 'Paint or clear cells, per-item results',
  })
  async paint(@Body() dto: PaintRosterDaysDto) {
    const results = unwrap(
      await this.rosterDays.paint(
        dto.items.map((item) => ({
          employeeId: item.employeeId,
          date: item.date,
          shiftId: item.shiftId ?? null,
          ...(item.worksOnHoliday === undefined ? {} : { worksOnHoliday: item.worksOnHoliday }),
          note: item.note ?? null,
        })),
      ),
    );
    return { data: { results }, meta: summarize(results) };
  }

  @Delete(':id')
  @RequirePermission('shift.roster.assign')
  @HttpCode(200)
  @ApiOperation({ operationId: 'clearRosterDay', summary: 'Clear a cell back to its pattern' })
  async clear(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.rosterDays.clear(id));
  }
}

/** UC-SHF-007 and UC-SHF-008 — the two self-service reads. */
@ApiTags('shift')
@Controller('me')
export class MyScheduleController {
  constructor(private readonly schedule: MyScheduleService) {}

  @Get('schedule')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getMySchedule', summary: 'My resolved window' })
  async mine(@Query() query: MyScheduleQueryDto) {
    const mine = unwrap(
      await this.schedule.mine({
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
      }),
    );
    return {
      data: mine.days,
      meta: {
        from: mine.from,
        to: mine.to,
        branchTimezone: mine.branchTimezone,
        generatedAt: mine.generatedAt,
      },
    };
  }

  @Get('team/schedule')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getTeamSchedule', summary: 'My direct reports, one date' })
  async team(@Query() query: TeamScheduleQueryDto) {
    return { data: unwrap(await this.schedule.team(query.date)) };
  }
}

function summarize(results: readonly { success: boolean }[]) {
  return {
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
  };
}
