import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { CursorMeta } from '../../../shared/envelope';
import { type KeysetPosition, decodeCursor, encodeCursor } from '../../../shared/http/cursor';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly } from '../../authz';
import { AcknowledgeService } from '../application/acknowledge.service';
import { InboxListService } from '../application/inbox-list.service';
import type { InboxListItem } from '../domain/inbox.types';
import { InboxQueryDto, MarkSeenDto } from './dto/inbox.dto';

/**
 * §7's five endpoints, every one of them `@AuthenticatedOnly()`.
 *
 * That is not a deviation and not an oversight — §2's permission column is `—`
 * on all three actions, because the module is *"entirely self-service"*.
 * Crucially it grants nothing either: §2 says so in as many words, and BR-INB-001
 * is why — an approval task deep-links into the owning module's screen, where
 * that module's permission and the engine's two-gate check (BR-APRV-012) both
 * still apply. Holding an inbox item has never been authority to act on it.
 *
 * The scope is structural rather than declared: every query is keyed by the
 * request's own user id, so there is no id a caller could supply to widen it.
 */
@ApiTags('inbox')
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly items: InboxListService,
    private readonly acknowledgements: AcknowledgeService,
  ) {}

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'listInboxItems',
    summary: 'UC-INB-003 — own items, newest first, `status=open` by default',
  })
  async list(@Query() query: InboxQueryDto) {
    const limit = query.limit ?? 20;
    const found = await this.items.list({
      limit,
      after: query.cursor ? toKeyset(decodeCursor(query.cursor)) : undefined,
      type: query.type,
      // §7's default. Applied here rather than in the service because it is the
      // wire contract's default, not the query's — a caller inside the process
      // states the status it means.
      status: query.status ?? 'open',
    });

    return { data: found.rows.map(toWire), meta: cursorMeta(found.rows, found.hasMore) };
  }

  @Get('count')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getInboxOpenCount', summary: 'Badge source (BR-INB-003)' })
  async count() {
    return { open: await this.items.openCount() };
  }

  @Post('seen-all')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'markAllInboxItemsSeen',
    summary: 'Operation-style path (auth §7 precedent); leaves the badge unchanged',
  })
  async seenAll() {
    return this.items.markAllSeen();
  }

  /**
   * Declared before `@Patch(':id')` for the reason that ordering is load-bearing
   * everywhere in Nest: routes match in declaration order, so a `:id` pattern
   * above a literal path swallows it and hands the literal to `ParseUUIDPipe`.
   * There is no literal `@Patch` path here today; the `@Post` above sits at
   * `seen-all` and is a different method, so nothing collides. Kept adjacent so
   * the next literal added to this controller lands on the right side.
   */
  @Patch(':id')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'markInboxItemSeen',
    summary: 'Idempotent; others’ items → 404',
  })
  // The body DTO is bound and never read: its whole job is to make the
  // ValidationPipe enforce §8's *"literal `true`"* rule, and without a bound
  // parameter Nest validates nothing — `{ seen: false }` would then succeed as a
  // seen mark, which §7 says is unsupported.
  async markSeen(@Param('id', ParseUUIDPipe) id: string, @Body() _body: MarkSeenDto) {
    const marked = unwrap(await this.items.markSeen(id));
    return { id: marked.id, seenAt: marked.seenAt.toISOString() };
  }

  /**
   * The platform's one queue-reachable offline write (BR-INB-007). §7 marks
   * `Idempotency-Key` accepted with `opId` as the key; the durable half is
   * BR-INB-008's 200 no-op, which holds past any store's window.
   */
  @Post(':id/acknowledge')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'acknowledgeInboxItem',
    summary: 'UC-INB-004 — ack items only; repeat returns the same doneAt',
  })
  async acknowledge(@Param('id', ParseUUIDPipe) id: string) {
    const done = unwrap(await this.acknowledgements.acknowledge(id));
    return { id: done.id, doneAt: done.doneAt.toISOString() };
  }
}

/** The cursor is a string on the wire and an instant in the query — this is the seam. */
function toKeyset(position: KeysetPosition) {
  return { createdAt: new Date(position.occurredAt), id: position.id };
}

function cursorMeta(rows: readonly InboxListItem[], hasMore: boolean): CursorMeta {
  const last = rows.at(-1);
  return {
    nextCursor:
      hasMore && last
        ? encodeCursor({ occurredAt: last.createdAt.toISOString(), id: last.id })
        : null,
    hasMore,
  };
}

/** §7's row. No `sourceRef` and no `params` — the client navigates by `deepLink`. */
function toWire(row: InboxListItem) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    subtitle: row.subtitle,
    deepLink: row.deepLink,
    dueAt: row.dueAt?.toISOString() ?? null,
    seenAt: row.seenAt?.toISOString() ?? null,
    doneAt: row.doneAt?.toISOString() ?? null,
    closedReason: row.closedReason,
    delegateOf: row.delegateOf,
    createdAt: row.createdAt.toISOString(),
  };
}
