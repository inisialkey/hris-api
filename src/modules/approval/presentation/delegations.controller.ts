import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { requireRequestContext } from '../../../shared/context';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly } from '../../authz';
import { DelegationService } from '../application/delegation.service';
import { toDelegation } from './approval.mapper';
import { offsetMeta } from './chains.controller';
import { CreateDelegationDto, DelegationQueryDto } from './dto/approval.dto';

/**
 * §2's one self-service row: *"Own delegation (create/end) — (authenticated
 * self-service), all roles"*.
 *
 * All three routes are `@AuthenticatedOnly()` and each one branches on
 * `approval.delegation.assign` **inside** the handler, because the permission
 * changes *whose* delegation the call is about rather than whether the call is
 * allowed. A `@RequirePermission` here would refuse an employee arranging their
 * own two weeks off, which is the primary use of the feature.
 */
@ApiTags('approval')
@Controller('approval/delegations')
export class ApprovalDelegationsController {
  constructor(private readonly delegations: DelegationService) {}

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'listApprovalDelegations', summary: 'Own, or all with the key' })
  async list(@Query() query: DelegationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const manageOthers = await this.canManageOthers();

    // Without the key the filter is forced to self, whatever the query string
    // said — an unprivileged caller asking for somebody else's delegations gets
    // their own rather than an error, because the parameter is a filter and not
    // a request for access.
    const delegatorUserId = manageOthers ? query.delegatorUserId : this.callerId();
    const found = await this.delegations.list(
      { delegatorUserId },
      { limit: pageSize, offset: (page - 1) * pageSize },
    );
    return {
      data: found.rows.map(toDelegation),
      meta: offsetMeta(page, pageSize, found.total),
    };
  }

  @Post()
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'createApprovalDelegation', summary: 'UC-APRV-006' })
  async create(@Body() dto: CreateDelegationDto) {
    const manageOthers = await this.canManageOthers();
    const delegatorUserId =
      dto.delegatorUserId && manageOthers ? dto.delegatorUserId : this.callerId();

    return toDelegation(
      unwrap(
        await this.delegations.create({
          delegatorUserId,
          delegateUserId: dto.delegateUserId,
          requestTypes: dto.requestTypes ?? null,
          startDate: dto.startDate,
          endDate: dto.endDate,
        }),
      ),
    );
  }

  @Post(':id/revoke')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'revokeApprovalDelegation', summary: 'Future activations only' })
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.delegations.revoke(id, this.callerId(), await this.canManageOthers()));
  }

  private async canManageOthers(): Promise<boolean> {
    const authorization = await requireRequestContext().authorization?.resolve();
    return authorization?.permissions.has('approval.delegation.assign') ?? false;
  }

  private callerId(): string {
    const userId = requireRequestContext().userId;
    // Past `JwtAuthGuard`, so a missing id is a wiring bug rather than an
    // anonymous caller — `SYS_INTERNAL` is the honest answer to an impossible
    // state, not a 404 that would read as "you have no delegations".
    if (!userId) throw new Error('authenticated route reached with no user id');
    return userId;
  }
}
