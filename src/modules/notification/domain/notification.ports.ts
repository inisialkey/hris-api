import type {
  DeliveryStatus,
  FanoutCommand,
  FeedCursor,
  FeedItem,
  NotificationChannel,
  NotificationRow,
  SendCommand,
  SendReport,
  TemplateParams,
} from './notification.types';

/**
 * Repository interfaces in `domain/`, where backend-nestjs §3 puts them; ports
 * are `Symbol` tokens plus interfaces so extraction later swaps the provider
 * without touching a consumer (ADR-0001 readiness criterion c).
 */

export interface NewNotification {
  userId: string;
  templateKey: string;
  dedupeKey: string;
  title: string;
  body: string;
  params: TemplateParams;
  deepLink?: string;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface NotificationRepositoryPort {
  /**
   * BR-NTF-004's whole mechanism: insert against `uq_notifications_dedupe` and
   * let the conflict decide. `null` means the row was already there — a
   * redelivered handler job or a relay replay, which is a no-op and not an
   * error.
   */
  insertIfNew(notification: NewNotification): Promise<NotificationRow | null>;

  /**
   * UC-NTF-004's cursor feed, newest first.
   *
   * **A feed item is a notification with a live `in_app` delivery**, not every
   * notification. An email-only template still writes a row — the row is the
   * parent of its deliveries and BR-NTF-008 wants the fact durable — but a
   * password-reset email is not feed traffic, and a channel a preference
   * suppressed is `skipped` rather than absent (§4.1). Deriving the population
   * from the delivery rows rather than from the template registry keeps the list
   * and the badge answering the same question, and keeps both answering it about
   * the rows that exist rather than about the registry as it reads today.
   */
  feed(
    userId: string,
    page: { limit: number; after?: FeedCursor; unreadOnly: boolean },
  ): Promise<{ rows: FeedItem[]; hasMore: boolean }>;

  /** Live count over the same population, bounded by retention (BR-NTF-010). */
  unreadCount(userId: string): Promise<number>;

  /**
   * `null` when no unread row of the caller's has that id — every other user's
   * row and every already-read row alike. The caller turns the first into 404
   * and the second into the idempotent success UC-NTF-004 promises, which is
   * why this returns the existing stamp rather than a boolean.
   */
  markRead(userId: string, id: string, now: Date): Promise<{ readAt: Date } | null>;

  markAllRead(userId: string, now: Date): Promise<number>;

  /** BR-NTF-010 — deliveries follow by `ON DELETE CASCADE`, preferences do not. */
  deleteCreatedBefore(cutoff: Date, limit: number): Promise<number>;

  findById(id: string): Promise<NotificationRow | null>;
}

export interface NewDelivery {
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  sentAt?: Date;
}

export const DELIVERY_REPOSITORY = Symbol('DELIVERY_REPOSITORY');

export interface DeliveryRepositoryPort {
  createMany(deliveries: readonly NewDelivery[]): Promise<void>;
  listFor(
    notificationId: string,
  ): Promise<{ channel: NotificationChannel; status: DeliveryStatus }[]>;
  /** §13's `NotificationStatsPort` read, one query behind the port. */
  countFailedSince(from: Date): Promise<number>;
}

export interface OptOut {
  templateKey: string;
  channel: NotificationChannel;
}

export const PREFERENCE_REPOSITORY = Symbol('PREFERENCE_REPOSITORY');

/** Opt-out rows only (BR-NTF-005) — the absence of a row is the default `on`. */
export interface PreferenceRepositoryPort {
  /** §7's matrix, for one user. */
  listForUser(userId: string): Promise<OptOut[]>;
  /**
   * The send path's read: one query for a whole fan-out chunk, keyed by user.
   * A per-recipient lookup would be 500 round trips inside one transaction on
   * one socket, which is the shape coding-standards-nestjs §4 forbids solving
   * with `Promise.all`.
   */
  optedOutChannels(
    userIds: readonly string[],
    templateKey: string,
  ): Promise<Map<string, Set<NotificationChannel>>>;
  optOut(userId: string, templateKey: string, channel: NotificationChannel): Promise<void>;
  optIn(userId: string, templateKey: string, channel: NotificationChannel): Promise<void>;
}

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

/**
 * UC-NTF-002 and UC-NTF-006 — the one contract every other module calls.
 *
 * Neither method returns a `Result`. A send has no business failure a caller can
 * act on: an unregistered template key or an unresolvable audience is a defect
 * in the caller, not a condition a user can be told about, and it throws for the
 * reason `SettingsPort.resolve` throws on an unknown key. What the report
 * carries is bookkeeping — how many rows were written, how many were already
 * there, how many channels a preference suppressed.
 */
export interface NotificationPort {
  send(command: SendCommand): Promise<SendReport>;
  /** BR-NTF-009 — chunked internally; callers hand over the whole list. */
  fanout(command: FanoutCommand): Promise<SendReport>;
}

export const NOTIFICATION_STATS_PORT = Symbol('NOTIFICATION_STATS_PORT');

/**
 * §13, for system-administration.md UC-ADM-010's platform-health page.
 *
 * The distinction the port draws is the reason it exists. A **failed delivery**
 * is a `notification_deliveries` row that exhausted the fast-retry class — the
 * recipient did not get the email or push. A **failed job** is a BullMQ entry in
 * the `notifications` queue's failed set, which that module reads straight from
 * the queue. One is a product outcome, the other an infrastructure event.
 */
export interface NotificationStatsPort {
  /** Count for the tenant in the caller's context, since `from` inclusive. */
  failedDeliveryCount(from: Date): Promise<number>;
}
