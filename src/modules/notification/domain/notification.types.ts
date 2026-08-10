/**
 * The module's own vocabulary. Hand-written rather than derived from the Drizzle
 * enums for the reason coding-standards-nestjs §5 gives: a row type is
 * infrastructure and the domain should not import one to describe itself.
 */

export type NotificationChannel = 'in_app' | 'push' | 'email';

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/**
 * D12's two, and the second one exists only as BR-NTF-006's fallback rung —
 * see `locale.ts` for why nothing in V1 ever resolves to it.
 */
export type Locale = 'id' | 'en';

/** Interpolation values for a template's variables (BR-NTF-006). */
export type TemplateParams = Record<string, string | number>;

export interface NotificationRow {
  id: string;
  userId: string;
  templateKey: string;
  dedupeKey: string;
  title: string;
  body: string;
  params: TemplateParams;
  deepLink: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** §7's feed row — no `dedupeKey` and no `params`, which are plumbing. */
export interface FeedItem {
  id: string;
  templateKey: string;
  title: string;
  body: string;
  deepLink: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface DeliveryRow {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  providerMessageId: string | null;
  errorCode: string | null;
  attempts: number;
  sentAt: Date | null;
}

/** One cell of the §7 preference matrix. */
export interface PreferenceCell {
  channel: NotificationChannel;
  enabled: boolean;
}

/** One row of the §7 preference matrix — the registry merged with opt-outs. */
export interface PreferenceRow {
  templateKey: string;
  module: string;
  mandatory: boolean;
  channels: PreferenceCell[];
}

/** The keyset position a cursor encodes for the newest-first feed. */
export interface FeedCursor {
  createdAt: Date;
  id: string;
}

/**
 * Who a send is addressed to. Explicit ids, or a role whose holders are resolved
 * **when the send runs** rather than when the cause occurred — §9's deliberate
 * choice: a just-granted admin gets it, a just-revoked one does not, because
 * notifications address people and not history.
 */
export type Recipients =
  | { kind: 'users'; userIds: readonly string[] }
  | { kind: 'role'; roleKey: string; companyId: string };

/** UC-NTF-002's command. */
export interface SendCommand {
  templateKey: string;
  recipients: Recipients;
  params: TemplateParams;
  /** BR-NTF-004 — `eventId` for event sends, caller-supplied otherwise. */
  dedupeKey: string;
  deepLink?: string;
}

/** UC-NTF-006's command — the same send, chunked (BR-NTF-009). */
export interface FanoutCommand {
  templateKey: string;
  userIds: readonly string[];
  params: TemplateParams;
  dedupeKey: string;
  deepLink?: string;
}

export interface SendReport {
  /** Rows written by this call — a redelivery reports 0 and is not an error. */
  created: number;
  /** Recipients whose row already existed (BR-NTF-004). */
  deduped: number;
  /** Deliveries suppressed by an opt-out (BR-NTF-005). */
  suppressed: number;
}
