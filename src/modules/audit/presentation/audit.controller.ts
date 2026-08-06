import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { CursorMeta } from '../../../shared/envelope';
import { type KeysetPosition, decodeCursor, encodeCursor } from '../../../shared/http/cursor';
import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { AnchorService } from '../application/anchor.service';
import { AuditQueryUseCase } from '../application/audit-query.use-case';
import type { AuditLogRow, KeysetCursor } from '../domain/audit.ports';
import { AuditLogQueryDto } from './dto/audit-query.dto';

/**
 * §7's three endpoints — all reads, all `audit.log.read`, and there is no fourth
 * because the module has no write surface (§2).
 *
 * Unlike auth's admin routes, these use `@RequirePermission` rather than an
 * imperative check: audit is a **tenant-level duty** (§2's data-scope column),
 * not a data-scoped resource, so there is no per-row existence to hide and a 403
 * is the honest refusal.
 */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly query: AuditQueryUseCase,
    private readonly anchors: AnchorService,
  ) {}

  @Get('logs')
  @RequirePermission('audit.log.read')
  @ApiOperation({ operationId: 'listAuditLogs', summary: 'Cursor feed over the audit log' })
  async list(@Query() dto: AuditLogQueryDto) {
    const limit = dto.limit ?? 20;
    const value = unwrap(
      await this.query.list(
        {
          entityType: dto.entityType,
          entityId: dto.entityId,
          actorUserId: dto.actorUserId,
          action: dto.action,
          actorType: dto.actorType,
          from: dto.from ? new Date(dto.from) : undefined,
          to: dto.to ? new Date(dto.to) : undefined,
        },
        { limit, after: dto.cursor ? toKeyset(decodeCursor(dto.cursor)) : undefined },
      ),
    );

    // The summary shape of §7 — `hasDiff` rather than the diff, so a feed page
    // never carries before/after values a detail request has not been audited
    // for. `actorName` is documented optional and stays absent until a module
    // owns the name (BR-AUD-006 resolves ids at render time).
    const data = value.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      impersonatorId: row.impersonatorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      requestId: row.requestId,
      hasDiff: row.diff !== null,
    }));

    return { data, meta: cursorMeta(value.rows, value.hasMore) };
  }

  @Get('logs/:id')
  @RequirePermission('audit.log.read')
  @ApiOperation({ operationId: 'getAuditLog', summary: 'One row, diff and metadata included' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    // Masked fields arrive masked and there is no unmask parameter (§7). A
    // reveal switch here would make every masking decision in §4.2 advisory.
    return unwrap(await this.query.detail(id));
  }

  @Post('anchors/:day/verify')
  @RequirePermission('audit.log.read')
  @ApiOperation({ operationId: 'verifyAuditAnchor', summary: 'Recompute a day and compare' })
  async verify(@Param('day') day: string) {
    return unwrap(await this.anchors.verify(day));
  }
}

/** The cursor is a string on the wire and an instant in the query — this is the seam. */
function toKeyset(position: KeysetPosition): KeysetCursor {
  return { occurredAt: new Date(position.occurredAt), id: position.id };
}

function cursorMeta(rows: readonly AuditLogRow[], hasMore: boolean): CursorMeta {
  const last = rows.at(-1);
  return {
    nextCursor:
      hasMore && last
        ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
        : null,
    hasMore,
  };
}
