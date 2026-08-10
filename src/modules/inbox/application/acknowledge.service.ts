import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext, requireTenantContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { inboxErrors } from '../domain/inbox.errors';
import {
  INBOX_OUTBOX,
  INBOX_REPOSITORY,
  type InboxOutboxPort,
  type InboxRepositoryPort,
} from '../domain/inbox.ports';
import type { InboxItemRow } from '../domain/inbox.types';

/**
 * UC-INB-004 — the one action the inbox itself owns, and the platform's single
 * queue-reachable offline write (BR-INB-007).
 *
 * **Idempotent by state rather than by a stored response.** §7 marks the
 * endpoint queue-reachable with `opId` as the `Idempotency-Key`, and this
 * repository has no shared idempotency store yet; offline-sync §5 is explicit
 * that a state-transition op replayed past the Redis window relies on the module
 * mapping an already-in-target-state call to replay-success, which BR-INB-008
 * specifies as a 200 returning the existing `doneAt`. So the durable half is
 * here and would be here regardless of what Redis remembers — a device dark for
 * a week drains against a `done` item and gets a success, not a spurious
 * failure.
 */
@Injectable()
export class AcknowledgeService {
  constructor(
    @Inject(INBOX_REPOSITORY) private readonly items: InboxRepositoryPort,
    @Inject(INBOX_OUTBOX) private readonly outbox: InboxOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async acknowledge(id: string): Promise<Result<{ id: string; doneAt: Date }>> {
    const userId = this.userId();
    const item = await this.items.findOwned(userId, id);
    // Another user's item and a nonexistent one are the same answer (§7:
    // "others' items → 404"; error-catalog §2).
    if (!item) return fail(sharedErrors.notFound());

    const settled = this.settled(item);
    if (settled) return settled;

    const completed = await this.items.complete(userId, id, this.clock.now());
    if (!completed) {
      // Something moved between the read and the update — the other device
      // acknowledged, or a retraction landed mid-flight. Re-asking the same
      // three questions of the row as it now stands is what keeps the second
      // case answering `INB_ITEM_CLOSED` rather than 404; the row exists, and
      // "not found" would send the client looking for a bug.
      const current = await this.items.findOwned(userId, id);
      return (current && this.settled(current)) ?? fail(sharedErrors.notFound());
    }

    // §12's one emitted event. announcement.md consumes it to stamp
    // `announcement_recipients.acknowledged_at` — this module owns the action
    // because it owns the offline queue class, that module owns the fact.
    await this.outbox.emit({
      name: 'inbox.item.acknowledged',
      tenantId: requireTenantContext().tenantId,
      aggregateId: id,
      payload: { itemId: id, userId, sourceRef: item.sourceRef },
    });

    return ok({ id, doneAt: completed.doneAt });
  }

  /**
   * BR-INB-008's three answers that write nothing, in the rule's own order.
   * `null` means go ahead and complete the item.
   *
   * An approval task is refused on what it **is**, before anything is asked
   * about what state it is in: the wrong answer for a closed approval task
   * would be `INB_ITEM_CLOSED`, which tells a client to show the
   * retracted-announcement notice for a task that was merely superseded.
   */
  private settled(item: InboxItemRow): Result<{ id: string; doneAt: Date }> | null {
    if (item.type !== 'acknowledgment') return fail(inboxErrors.notAcknowledgeable());

    if (item.status === 'closed') {
      // §9's ack-after-retraction race: the queue drained against a post that
      // was taken back. Terminal per offline-sync §5's class rules — the client
      // shows the retracted notice and never retries, which is why the reason
      // rides in `details` (error-catalog §11).
      return fail(inboxErrors.itemClosed({ closedReason: item.closedReason ?? 'retracted' }));
    }

    // BR-INB-008 — a replay, or the second of two devices. Success, same stamp,
    // no second event: announcement.md's handler is idempotent anyway, and an
    // event per tap would make its ack rate a count of taps.
    if (item.status === 'done' && item.doneAt) return ok({ id: item.id, doneAt: item.doneAt });

    return null;
  }

  private userId(): string {
    const userId = requireRequestContext().userId;
    if (!userId) throw new Error('acknowledge outside an authenticated request');
    return userId;
  }
}
