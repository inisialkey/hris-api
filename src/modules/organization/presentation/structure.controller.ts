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

import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { BranchService } from '../application/branch.service';
import { DepartmentService } from '../application/department.service';
import { JobLevelService } from '../application/job-level.service';
import { PositionService } from '../application/position.service';
import { offsetMeta } from './companies.controller';
import {
  BranchQueryDto,
  CreateBranchDto,
  CreateDepartmentDto,
  CreateJobLevelDto,
  CreatePositionDto,
  DepartmentQueryDto,
  PositionQueryDto,
  UpdateBranchDto,
  UpdateDepartmentDto,
  UpdateJobLevelDto,
  UpdatePositionDto,
} from './dto/organization.dto';

/**
 * The four structure resources of §7. They share one permission pair —
 * `organization.structure.read` / `.configure` — which is the cohesion that puts
 * them in one file: a change to how structure is scoped is a change to all four.
 */

@ApiTags('organization')
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchService) {}

  @Get()
  @RequirePermission('organization.structure.read')
  @ApiOperation({ operationId: 'listBranches', summary: 'Branches of one company' })
  async list(@Query() query: BranchQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.branches.list(
        { companyId: query.companyId, q: query.q },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );

    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Post()
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'createBranch', summary: 'Add a branch and its timezone' })
  async create(@Body() dto: CreateBranchDto) {
    return unwrap(
      await this.branches.create({
        companyId: dto.companyId,
        code: dto.code,
        name: dto.name,
        timezone: dto.timezone,
        address: dto.address ?? null,
        ...coordinates(dto),
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'updateBranch', summary: 'Edit a branch (timezone emits an event)' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    return unwrap(
      await this.branches.update(id, {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.timezone === undefined ? {} : { timezone: dto.timezone }),
        ...(dto.address === undefined ? {} : { address: dto.address }),
        ...(dto.latitude === undefined && dto.longitude === undefined ? {} : coordinates(dto)),
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('organization.structure.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveBranch', summary: 'Archive, blocked by live assignments' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.branches.archive(id));
    return { id };
  }
}

@ApiTags('organization')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentService) {}

  @Get()
  @RequirePermission('organization.structure.read')
  @ApiOperation({ operationId: 'listDepartments', summary: 'Flat page, or the nested forest' })
  async list(@Query() query: DepartmentQueryDto) {
    // `?tree=true` is unpaginated on purpose (§7): the depth cap bounds the
    // forest, and a paged tree is a tree with its branches cut off.
    if (query.tree) return { data: unwrap(await this.departments.tree(query.companyId)) };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.departments.list(
        { companyId: query.companyId },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );

    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Post()
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'createDepartment', summary: 'Add a department' })
  async create(@Body() dto: CreateDepartmentDto) {
    return unwrap(
      await this.departments.create({
        companyId: dto.companyId,
        parentDepartmentId: dto.parentDepartmentId ?? null,
        code: dto.code,
        name: dto.name,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'updateDepartment', summary: 'Rename or re-parent a subtree' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentDto) {
    return unwrap(
      await this.departments.update(id, {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.parentDepartmentId === undefined
          ? {}
          : { parentDepartmentId: dto.parentDepartmentId }),
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('organization.structure.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveDepartment', summary: 'Archive, blocked by live children' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.departments.archive(id));
    return { id };
  }
}

@ApiTags('organization')
@Controller('job-levels')
export class JobLevelsController {
  constructor(private readonly jobLevels: JobLevelService) {}

  @Get()
  @RequirePermission('organization.structure.read')
  @ApiOperation({ operationId: 'listJobLevels', summary: 'Tenant-wide grade bands, by rank' })
  list() {
    // Unpaginated, a deliberate §7 deviation: a tenant holds dozens of bands and
    // every position form needs all of them in one picker.
    return this.jobLevels.list();
  }

  @Post()
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'createJobLevel', summary: 'Add a grade band' })
  async create(@Body() dto: CreateJobLevelDto) {
    return unwrap(await this.jobLevels.create({ code: dto.code, name: dto.name, rank: dto.rank }));
  }

  @Patch(':id')
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'updateJobLevel', summary: 'Rename or re-rank a band' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJobLevelDto) {
    return unwrap(await this.jobLevels.update(id, dto));
  }

  @Delete(':id')
  @RequirePermission('organization.structure.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveJobLevel', summary: 'Archive, blocked by live positions' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.jobLevels.archive(id));
    return { id };
  }
}

@ApiTags('organization')
@Controller('positions')
export class PositionsController {
  constructor(private readonly positions: PositionService) {}

  @Get()
  @RequirePermission('organization.structure.read')
  @ApiOperation({ operationId: 'listPositions', summary: 'Positions of one company' })
  async list(@Query() query: PositionQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.positions.list(
        {
          companyId: query.companyId,
          departmentId: query.departmentId,
          jobLevelId: query.jobLevelId,
          vacant: query.vacant,
          q: query.q,
        },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );

    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Post()
  @RequirePermission('organization.structure.configure')
  @ApiOperation({ operationId: 'createPosition', summary: 'Add a position and its reporting line' })
  async create(@Body() dto: CreatePositionDto) {
    return unwrap(
      await this.positions.create({
        companyId: dto.companyId,
        departmentId: dto.departmentId,
        jobLevelId: dto.jobLevelId,
        code: dto.code,
        title: dto.title,
        reportsToPositionId: dto.reportsToPositionId ?? null,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('organization.structure.configure')
  @ApiOperation({
    operationId: 'updatePosition',
    summary: 'Edit a position (reports-to is checked)',
  })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePositionDto) {
    return unwrap(
      await this.positions.update(id, {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        ...(dto.departmentId === undefined ? {} : { departmentId: dto.departmentId }),
        ...(dto.jobLevelId === undefined ? {} : { jobLevelId: dto.jobLevelId }),
        ...(dto.reportsToPositionId === undefined
          ? {}
          : { reportsToPositionId: dto.reportsToPositionId }),
      }),
    );
  }

  @Delete(':id')
  @RequirePermission('organization.structure.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archivePosition', summary: 'Archive, blocked by holders' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.positions.archive(id));
    return { id };
  }
}

/**
 * §8: latitude and longitude are stored as `numeric`, so they arrive as numbers
 * and are written as strings — never through `parseFloat`, which is the same
 * rule money follows and for the same reason.
 */
function coordinates(dto: { latitude?: number; longitude?: number }): {
  latitude: string | null;
  longitude: string | null;
} {
  return {
    latitude: dto.latitude === undefined ? null : String(dto.latitude),
    longitude: dto.longitude === undefined ? null : String(dto.longitude),
  };
}
