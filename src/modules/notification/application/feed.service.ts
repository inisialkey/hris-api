import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepositoryPort,
} from '../domain/notification.ports';
import type { FeedCursor, FeedItem } from '../domain/notification.types';

/**
 * UC-NTF-004 — the feed, the badge, and the two ways a row stops being unread.
 *
 * **Own rows only, structurally.** Every method reads the user id out of the
 * request context and passes it to the query; there is no parameter a caller
 * could supply and therefore no scope to get wrong. §7 says so of the list
 * (*"own feed"*) and of mark-read (*"others' rows → 404"*), and the same
 * predicate delivers both — a row belonging to someone else simply does not
 * match, which is the existence-hiding answer rather than a 403.
 *
 * There is no permission key anywhere in this file. §2 is entirely
 * self-service: reading your own feed is not an act anyone grants.
 */
@Injectable()
export class FeedService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepositoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(page: {
    limit: number;
    after?: FeedCursor;
    unreadOnly: boolean;
  }): Promise<{ rows: FeedItem[]; hasMore: boolean }> {
    return this.notifications.feed(this.userId(), page);
  }

  /**
   * §7's badge source, and a live `COUNT` rather than a maintained counter. The
   * number is bounded by BR-NTF-010's retention rather than by the feed's whole
   * history, and a counter would be one more thing that can disagree with the
   * list it labels.
   */
  unreadCount(): Promise<number> {
    return this.notifications.unreadCount(this.userId());
  }

  /**
   * `{ read: true }` is the only accepted body (§7 — there is no unread
   * restore), so this method takes no flag. Idempotent: a second call returns
   * the stamp the first one wrote rather than moving it.
   */
  async markRead(id: string): Promise<Result<{ id: string; readAt: Date }>> {
    const stamped = await this.notifications.markRead(this.userId(), id, this.clock.now());
    if (!stamped) return fail(sharedErrors.notFound());
    return ok({ id, readAt: stamped.readAt });
  }

  async markAllRead(): Promise<{ updatedCount: number }> {
    return { updatedCount: await this.notifications.markAllRead(this.userId(), this.clock.now()) };
  }

  private userId(): string {
    const userId = requireRequestContext().userId;
    // Every route here is `@AuthenticatedOnly()`, so the guard chain has already
    // proven an identity; a missing one is a wiring fault and not a 401 to
    // render from inside a use case.
    if (!userId) throw new Error('feed read outside an authenticated request');
    return userId;
  }
}
