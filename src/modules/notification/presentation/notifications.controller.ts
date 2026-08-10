import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { CursorMeta } from '../../../shared/envelope';
import { type KeysetPosition, decodeCursor, encodeCursor } from '../../../shared/http/cursor';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly } from '../../authz';
import { FeedService } from '../application/feed.service';
import { PreferenceService } from '../application/preference.service';
import type { FeedItem } from '../domain/notification.types';
import { FeedQueryDto, MarkReadDto, UpdatePreferenceDto } from './dto/notification.dto';

/**
 * §7's six endpoints, every one of them `@AuthenticatedOnly()`.
 *
 * That is not a deviation and not an oversight — §2's permission column is `—`
 * on all three actions, because the module is *"entirely self-service"*: reading
 * your own feed, marking your own row read, and choosing what reaches you are
 * not acts anyone grants. The scope is structural rather than declared: every
 * query is keyed by the request's own user id, so there is no id a caller could
 * supply to widen it.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly feed: FeedService,
    private readonly preferences: PreferenceService,
  ) {}

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'listNotifications',
    summary: 'UC-NTF-004 — own feed, newest first',
  })
  async list(@Query() query: FeedQueryDto) {
    const limit = query.limit ?? 20;
    const found = await this.feed.list({
      limit,
      after: query.cursor ? toKeyset(decodeCursor(query.cursor)) : undefined,
      unreadOnly: query.unread ?? false,
    });

    return { data: found.rows.map(toWire), meta: cursorMeta(found.rows, found.hasMore) };
  }

  @Get('unread-count')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getUnreadNotificationCount', summary: 'Badge source' })
  async unreadCount() {
    return { count: await this.feed.unreadCount() };
  }

  @Post('read-all')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'markAllNotificationsRead',
    summary: 'Operation-style path (auth §7)',
  })
  async readAll() {
    return this.feed.markAllRead();
  }

  @Get('preferences')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'listNotificationPreferences', summary: 'UC-NTF-005 — full matrix' })
  async listPreferences() {
    return { data: await this.preferences.matrix() };
  }

  @Patch('preferences')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'updateNotificationPreference', summary: 'One cell' })
  async updatePreference(@Body() dto: UpdatePreferenceDto) {
    return unwrap(await this.preferences.toggle(dto.templateKey, dto.channel, dto.enabled));
  }

  /**
   * **Declared last, and that is load-bearing.** Nest matches routes in
   * declaration order, so a `@Patch(':id')` above `@Patch('preferences')` would
   * swallow the literal path and hand `'preferences'` to `ParseUUIDPipe` — a
   * 400 on the endpoint §7 specifies, with nothing in the type system to notice.
   */
  @Patch(':id')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'markNotificationRead', summary: 'Idempotent; others’ rows → 404' })
  // The body DTO is bound and never read: its whole job is to make the
  // ValidationPipe enforce §8's *"literal `true`"* rule, and without a bound
  // parameter Nest validates nothing — `{ read: false }` would then succeed as
  // a read, which §7 says is unsupported.
  async markRead(@Param('id', ParseUUIDPipe) id: string, @Body() _body: MarkReadDto) {
    const marked = unwrap(await this.feed.markRead(id));
    return { id: marked.id, readAt: marked.readAt.toISOString() };
  }
}

/** The cursor is a string on the wire and an instant in the query — this is the seam. */
function toKeyset(position: KeysetPosition) {
  return { createdAt: new Date(position.occurredAt), id: position.id };
}

function cursorMeta(rows: readonly FeedItem[], hasMore: boolean): CursorMeta {
  const last = rows.at(-1);
  return {
    nextCursor:
      hasMore && last
        ? encodeCursor({ occurredAt: last.createdAt.toISOString(), id: last.id })
        : null,
    hasMore,
  };
}

/** §7's row — `templateKey` for client-side grouping, never `params`, never `dedupeKey`. */
function toWire(row: FeedItem) {
  return {
    id: row.id,
    templateKey: row.templateKey,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
