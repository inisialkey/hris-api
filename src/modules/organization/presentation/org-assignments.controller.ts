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
import { MoveUseCase } from '../application/move.use-case';
import { PositionService } from '../application/position.service';
import { ChartQueryDto, CreateAssignmentDto } from './dto/organization.dto';

@ApiTags('organization')
@Controller('employees/:employeeId/org-assignments')
export class OrgAssignmentsController {
  constructor(private readonly moves: MoveUseCase) {}

  @Get()
  @RequirePermission('organization.assignment.read')
  @ApiOperation({ operationId: 'listOrgAssignments', summary: 'Full placement history' })
  async list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    // Unpaginated (§7): a person's placement history is a handful of rows, and
    // cancelled ones stay in it flagged rather than disappearing.
    return unwrap(await this.moves.history(employeeId));
  }

  @Post()
  @RequirePermission('organization.assignment.assign')
  @ApiOperation({
    operationId: 'moveEmployee',
    summary: 'Transfer, promote or correct a placement',
  })
  async create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateAssignmentDto,
  ) {
    return unwrap(
      await this.moves.move(employeeId, {
        positionId: dto.positionId,
        branchId: dto.branchId,
        kind: dto.kind,
        note: dto.note,
        effectiveFrom: dto.effectiveFrom,
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('organization.assignment.assign')
  @HttpCode(200)
  @ApiOperation({ operationId: 'cancelOrgAssignment', summary: 'Cancel a scheduled move' })
  async cancel(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return unwrap(await this.moves.cancel(employeeId, id));
  }
}

@ApiTags('organization')
@Controller('organization')
export class OrganizationChartController {
  constructor(private readonly positions: PositionService) {}

  /**
   * The one surface in this module with no permission key (§7). Every employee
   * may see their own company's chart, and BR-ORG-005 is what makes that safe to
   * render: a vacant seat is a visible fact, not a leak.
   */
  @Get('chart')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'organizationChart', summary: 'Positions as a flat forest' })
  async chart(@Query() query: ChartQueryDto) {
    return unwrap(await this.positions.chart(query));
  }
}
