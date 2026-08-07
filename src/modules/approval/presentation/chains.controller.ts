import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { ChainService } from '../application/chain.service';
import { toChainDetail, toChainSummary } from './approval.mapper';
import { ChainQueryDto, CreateChainDto, UpdateChainDto } from './dto/approval.dto';

/**
 * §7's config surface. **No action endpoints here, and that is the design
 * decision rather than an omission**: `approve`, `reject`, `return`, `cancel`
 * and `submit` are module-owned HTTP routes calling `ApprovalPort` in-process,
 * so a route's permission stays static (BR-AUTHZ-002) and the owning module can
 * run its domain effect in the same transaction.
 */
@ApiTags('approval')
@Controller('approval/chains')
export class ApprovalChainsController {
  constructor(private readonly chains: ChainService) {}

  @Get()
  @RequirePermission('approval.chain.read')
  @ApiOperation({ operationId: 'listApprovalChains', summary: 'Chains per request type' })
  async list(@Query() query: ChainQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.chains.list(
        { requestType: query.requestType, companyId: query.companyId },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );
    return {
      data: found.rows.map(toChainSummary),
      meta: offsetMeta(page, pageSize, found.total),
    };
  }

  @Post()
  @RequirePermission('approval.chain.configure')
  @ApiOperation({ operationId: 'createApprovalChain', summary: 'UC-APRV-008' })
  async create(@Body() dto: CreateChainDto) {
    return toChainDetail(
      unwrap(
        await this.chains.create({
          requestType: dto.requestType,
          companyId: dto.companyId ?? null,
          name: dto.name,
          priority: dto.priority,
          conditions: dto.conditions,
          steps: dto.steps,
          isActive: dto.isActive,
        }),
      ),
    );
  }

  @Get(':id')
  @RequirePermission('approval.chain.read')
  @ApiOperation({ operationId: 'getApprovalChain', summary: 'Chain with its steps' })
  async byId(@Param('id', ParseUUIDPipe) id: string) {
    return toChainDetail(unwrap(await this.chains.get(id)));
  }

  @Patch(':id')
  @RequirePermission('approval.chain.configure')
  @ApiOperation({ operationId: 'updateApprovalChain', summary: 'Edit — new instances only' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChainDto) {
    return toChainDetail(unwrap(await this.chains.update(id, dto)));
  }

  /**
   * Soft delete. In-flight instances are unaffected — they run their snapshot
   * (BR-APRV-004) — which is why this is not blocked on live instances the way
   * an organization archive is blocked on live assignments.
   */
  @Delete(':id')
  @RequirePermission('approval.chain.configure')
  @ApiOperation({ operationId: 'deleteApprovalChain', summary: 'Archive a chain' })
  async archive(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.chains.archive(id));
  }
}

export interface OffsetMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
