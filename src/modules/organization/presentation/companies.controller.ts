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
import { CompanyService } from '../application/company.service';
import { CompanyQueryDto, CreateCompanyDto, UpdateCompanyDto } from './dto/organization.dto';

/**
 * §7's company endpoints. Creating and archiving need a **tenant-wide**
 * assignment on top of the permission key (§2), which the service checks — the
 * guard sees the key, not the assignment's shape.
 */
@ApiTags('organization')
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompanyService) {}

  @Get()
  @RequirePermission('organization.company.read')
  @ApiOperation({ operationId: 'listCompanies', summary: 'Companies in the caller’s scope' })
  async list(@Query() query: CompanyQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = await this.companies.list(
      { q: query.q },
      { limit: pageSize, offset: (page - 1) * pageSize },
    );

    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  @Post()
  @RequirePermission('organization.company.configure')
  @ApiOperation({ operationId: 'createCompany', summary: 'Register a company' })
  async create(@Body() dto: CreateCompanyDto) {
    return unwrap(
      await this.companies.create({
        code: dto.code,
        name: dto.name,
        legalName: dto.legalName ?? null,
        npwp: dto.npwp ?? null,
        address: dto.address ?? null,
        phone: dto.phone ?? null,
      }),
    );
  }

  @Patch(':id')
  @RequirePermission('organization.company.configure')
  @ApiOperation({ operationId: 'updateCompany', summary: 'Edit legal identity' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto) {
    return unwrap(await this.companies.update(id, dto));
  }

  @Delete(':id')
  @RequirePermission('organization.company.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'archiveCompany', summary: 'Archive, blocked by live dependents' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    unwrap(await this.companies.archive(id));
    return { id };
  }
}

export function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
