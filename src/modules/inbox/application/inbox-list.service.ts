import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { INBOX_REPOSITORY, type InboxRepositoryPort } from '../domain/inbox.ports';
import type {
  InboxCursor,
  InboxItemType,
  InboxListItem,
  InboxItemStatus,
} from '../domain/inbox.types';

/**
 * UC-INB-003 — the list, the badge, and the two ways an item stops being unseen.
 *
 * **Own rows only, structurally.** Every method reads the user id out of the
 * request context and passes it to the query; there is no parameter a caller
 * could supply and therefore no scope to get wrong. §7 says so of the list
 * (*"structurally user-scoped"*) and of the seen mark (*"others' items → 404"*),
 * and the same predicate delivers both — another user's row simply does not
 * match, which is error-catalog §2's existence-hiding answer rather than a 403.
 *
 * There is no permission key anywhere in this file. §2 is *"entirely
 * self-service"*: reading your own tasks is not an act anyone grants, and the
 * one thing the inbox would otherwise be granting — the right to act on an
 * approval — it explicitly does not (BR-INB-001, BR-APRV-012's two gates live
 * on the module endpoint).
 */
@Injectable()
export class InboxListService {
  constructor(
    @Inject(INBOX_REPOSITORY) private readonly items: InboxRepositoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(query: {
    limit: number;
    after?: InboxCursor;
    type?: InboxItemType;
    status: InboxItemStatus;
  }): Promise<{ rows: InboxListItem[]; hasMore: boolean }> {
    return this.items.list(this.userId(), query);
  }

  /**
   * BR-INB-003's badge — a live `COUNT` of `open`, not a maintained counter.
   * `seen_at` is nowhere in it: *"a task glanced at is still a task"*. The number
   * is bounded by the open set rather than by the retention window, because
   * BR-INB-010 never purges an `open` item.
   */
  openCount(): Promise<number> {
    return this.items.openCount(this.userId());
  }

  /**
   * `{ seen: true }` is the only accepted body (§7 — there is no unsee), so this
   * method takes no flag. Idempotent: a second call returns the stamp the first
   * one wrote rather than moving it, which matters more here than for a
   * notification — offline-sync §10 puts `seen` in the **cosmetic replay lane**,
   * re-sent fire-and-forget on every reconnect.
   */
  async markSeen(id: string): Promise<Result<{ id: string; seenAt: Date }>> {
    const stamped = await this.items.markSeen(this.userId(), id, this.clock.now());
    if (!stamped) return fail(sharedErrors.notFound());
    return ok({ id, seenAt: stamped.seenAt });
  }

  async markAllSeen(): Promise<{ updatedCount: number }> {
    return { updatedCount: await this.items.markAllSeen(this.userId(), this.clock.now()) };
  }

  private userId(): string {
    const userId = requireRequestContext().userId;
    // Every route here is `@AuthenticatedOnly()`, so the guard chain has already
    // proven an identity; a missing one is a wiring fault and not a 401 to
    // render from inside a use case.
    if (!userId) throw new Error('inbox read outside an authenticated request');
    return userId;
  }
}
