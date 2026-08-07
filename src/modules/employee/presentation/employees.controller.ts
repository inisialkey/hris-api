import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import type { OffsetMeta } from '../../../shared/envelope';
import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { EmployeeService } from '../application/employee.service';
import { HireUseCase } from '../application/hire.use-case';
import { RevealService } from '../application/reveal.service';
import { TerminateUseCase } from '../application/terminate.use-case';
import { toBusinessDate } from '../domain/dates';
import {
  CreateEmployeeDto,
  EmployeeQueryDto,
  TerminateEmployeeDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { toDetailResponse, toListResponse } from './employee.mapper';

/**
 * §7's `/employees` surface.
 *
 * Every read here is masked by the mapper (BR-EMP-003) — the one exception is
 * `/sensitive`, which is a different permission key and writes an audit row.
 */
@ApiTags('employee')
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly hire: HireUseCase,
    private readonly terminate: TerminateUseCase,
    private readonly revealService: RevealService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @RequirePermission('employee.master.read')
  @ApiOperation({ operationId: 'listEmployees', summary: 'Employees in the caller’s scope' })
  async list(@Query() query: EmployeeQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = await this.employees.list(
      {
        companyId: query.companyId,
        status: query.status,
        employmentType: query.employmentType,
        q: query.q,
      },
      { limit: pageSize, offset: (page - 1) * pageSize },
      this.today(),
    );

    return {
      data: found.rows.map(toListResponse),
      meta: offsetMeta(page, pageSize, found.total),
    };
  }

  @Post()
  @RequirePermission('employee.master.create')
  @ApiOperation({ operationId: 'hireEmployee', summary: 'Hire — one transaction (BR-EMP-002)' })
  async create(@Body() dto: CreateEmployeeDto) {
    const employee = unwrap(await this.hire.execute({ ...dto }));
    // Read the row back rather than assembling a response from the create
    // inputs: the hire wrote a placement, a contract and a status row in this
    // same transaction, and §7 promises the masked **detail** shape. Composing
    // one by hand would answer `placement: null` moments after seeding it.
    return toDetailResponse(unwrap(await this.employees.detail(employee.id, this.today())));
  }

  @Get(':id')
  @RequirePermission('employee.master.read')
  @ApiOperation({ operationId: 'getEmployee', summary: 'Masked detail (§4.3)' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return toDetailResponse(unwrap(await this.employees.detail(id, this.today())));
  }

  @Patch(':id')
  @RequirePermission('employee.master.update')
  @ApiOperation({ operationId: 'updateEmployee', summary: 'UC-EMP-002 — trusted-admin edit' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) {
    unwrap(await this.employees.update(id, dto));
    return toDetailResponse(unwrap(await this.employees.detail(id, this.today())));
  }

  @Delete(':id')
  @RequirePermission('employee.master.delete')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteEmployee', summary: 'Terminal rows only (BR-EMP-013)' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.employees.archive(id));
    return { id };
  }

  @Post(':id/terminate')
  @RequirePermission('employee.termination.execute')
  @HttpCode(200)
  @ApiOperation({ operationId: 'terminateEmployee', summary: 'UC-EMP-006' })
  async terminateEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TerminateEmployeeDto,
  ) {
    return unwrap(await this.terminate.execute(id, dto));
  }

  /**
   * UC-EMP-003. `no-store` is not decoration: a cached reveal is a full NIK
   * sitting in a proxy for someone who never asked for it and left no audit row.
   */
  @Get(':id/sensitive')
  @RequirePermission('employee.sensitive.read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'revealEmployee', summary: 'Full values — audited (§4.3)' })
  async reveal(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.revealService.reveal(id));
  }

  private today(): string {
    return toBusinessDate(this.clock.now());
  }
}

export function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
