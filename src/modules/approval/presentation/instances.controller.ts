import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { requireRequestContext } from '../../../shared/context';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, RequirePermission } from '../../authz';
import { InstanceQueryService } from '../application/instance-query.service';
import { offsetMeta } from './chains.controller';
import { toInstanceDetail } from './approval.mapper';
import { InstanceQueryDto } from './dto/approval.dto';

@ApiTags('approval')
@Controller('approval')
export class ApprovalInstancesController {
  constructor(private readonly instances: InstanceQueryService) {}

  /** The oversight grid. Read-only by design — oversight is not approval rights. */
  @Get('instances')
  @RequirePermission('approval.instance.read')
  @ApiOperation({ operationId: 'listApprovalInstances', summary: 'Oversight grid, §7' })
  async list(@Query() query: InstanceQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.instances.list(
        {
          requestType: query.requestType,
          status: query.status,
          stuck: query.stuck,
          slaState: query.slaState,
          companyId: query.companyId,
        },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );
    return { data: found.rows, meta: offsetMeta(page, pageSize, found.total) };
  }

  /**
   * `@AuthenticatedOnly()`, and the visibility rule lives in the service.
   *
   * BR-APRV-012's read set is *"requester, current+past assignees, oversight
   * readers"* — three groups of which only the third has a permission key, so a
   * `@RequirePermission` here would lock out the two groups the timeline exists
   * for. The service resolves the caller's oversight permission itself and falls
   * back to the relationship test, answering 404 outside the set.
   */
  @Get('instances/:id')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getApprovalInstance', summary: 'Instance timeline' })
  async byId(@Param('id', ParseUUIDPipe) id: string) {
    return toInstanceDetail(unwrap(await this.instances.byId(id, await this.oversight())));
  }

  /** §7's second form — the newest instance for a request, plus its predecessors. */
  @Get('requests/:requestType/:requestId')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getApprovalForRequest', summary: 'Timeline by request' })
  async byRequest(
    @Param('requestType') requestType: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ) {
    return toInstanceDetail(
      unwrap(await this.instances.byRequest(requestType, requestId, await this.oversight())),
    );
  }

  /**
   * ADR-0005's lazy resolution: the permission set is looked up only on these two
   * routes, where the answer changes what the caller may see. An approver opening
   * their own request pays nothing for a key they do not hold.
   */
  private async oversight(): Promise<boolean> {
    const authorization = await requireRequestContext().authorization?.resolve();
    return authorization?.permissions.has('approval.instance.read') ?? false;
  }
}
