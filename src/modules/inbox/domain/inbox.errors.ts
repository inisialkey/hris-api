import { AppError } from '../../../shared/app-error';

import type { ClosedReason } from './inbox.types';

/**
 * §11's two codes, and two is the whole surface this module can refuse with.
 * Everything else it answers is a read of the caller's own rows: another user's
 * item is `SYS_NOT_FOUND` (existence hiding, error-catalog §2) rather than a
 * code of its own, and an unknown `type` or `status` filter is `VAL_INVALID_ENUM`
 * from §8's validation layer.
 *
 * **Acknowledging a `done` item raises nothing.** BR-INB-008 makes it a 200
 * no-op returning the existing stamp, because the offline queue replays it —
 * offline-sync §5's *"modules may map already-in-target-state rejections to
 * replay-success"*, which is what makes acknowledge safe past the idempotency
 * window without a stored response.
 */
export const inboxErrors = {
  /** BR-INB-008 — an approval task leaves via action, quorum or terminality. */
  notAcknowledgeable: () => new AppError('INB_NOT_ACKNOWLEDGEABLE'),

  /** BR-INB-008 — the announcement was retracted while the ack sat in a queue. */
  itemClosed: (params: { closedReason: ClosedReason }) => new AppError('INB_ITEM_CLOSED', params),
} as const;

export const inboxErrorStatus = {
  INB_NOT_ACKNOWLEDGEABLE: 422,
  INB_ITEM_CLOSED: 409,
} as const;
