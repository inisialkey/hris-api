import type {
  AckItemsReport,
  ClosedReason,
  CreateAckItemsCommand,
  InboxItemRow,
  InboxItemType,
  InboxListItem,
  InboxListQuery,
  SourceRef,
  TitleParams,
} from './inbox.types';

/**
 * Repository interfaces in `domain/`, where backend-nestjs §3 puts them; ports
 * are `Symbol` tokens plus interfaces so extraction later swaps the provider
 * without touching a consumer (ADR-0001 readiness criterion c).
 */

export interface NewInboxItem {
  userId: string;
  type: InboxItemType;
  dedupeKey: string;
  title: string;
  subtitle: string | null;
  params: TitleParams;
  sourceRef: SourceRef;
  deepLink: string;
  dueAt: Date | null;
}

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');

export interface InboxRepositoryPort {
  /**
   * BR-INB-004's whole mechanism: insert against `uq_inbox_items_dedupe` and let
   * the conflict decide. Returns how many of the batch were new, so a
   * redelivered handler job reports zero rather than failing — *"redeliveries
   * no-op on the unique index (ADR-0010 law)"*.
   */
  insertIfNew(items: readonly NewInboxItem[]): Promise<number>;

  /** UC-INB-003's cursor list, newest first. */
  list(userId: string, query: InboxListQuery): Promise<{ rows: InboxListItem[]; hasMore: boolean }>;

  /**
   * BR-INB-003's badge — **`open` only**. `seen_at` is presentation and never
   * reduces it: a task glanced at is still a task.
   */
  openCount(userId: string): Promise<number>;

  findOwned(userId: string, id: string): Promise<InboxItemRow | null>;

  /**
   * `null` when no unseen row of the caller's has that id — another user's row
   * and an already-seen row alike. The caller turns the first into 404 and the
   * second into a no-op success, which is why this returns the existing stamp
   * rather than a boolean.
   */
  markSeen(userId: string, id: string, at: Date): Promise<{ seenAt: Date } | null>;

  /** UC-INB-003's `seen-all`; returns the count §7's response carries. */
  markAllSeen(userId: string, at: Date): Promise<number>;

  /** `open → done`. `null` when the row was not `open`, and the caller decides. */
  complete(userId: string, id: string, at: Date): Promise<{ doneAt: Date } | null>;

  /**
   * BR-INB-006's actor completion. Keyed on `(user, dedupeKey)` because
   * `approval.assignee.acted` carries the **assignee row id**, which BR-INB-004
   * made the dedupe key for exactly this lookup — one hit on
   * `uq_inbox_items_dedupe`, no scan.
   */
  completeByDedupeKey(userId: string, dedupeKey: string, at: Date): Promise<number>;

  /**
   * BR-INB-006's sibling and remainder closure. `stepId` present = one step's
   * remaining seats (`any`-quorum losers); absent = every open item of the
   * instance (a terminal). Only `open` rows move — a `done` item stays done.
   */
  closeApprovalItems(
    instanceId: string,
    stepId: string | null,
    reason: ClosedReason,
  ): Promise<number>;

  /** UC-INB-005's retraction half — open ack items of one announcement. */
  closeByDedupeKey(dedupeKey: string, reason: ClosedReason): Promise<number>;

  /** BR-INB-010 — non-`open` only; an `open` task never silently vanishes. */
  deleteClosedBefore(cutoff: Date, limit: number): Promise<number>;
}

export const INBOX_PORT = Symbol('INBOX_PORT');

/**
 * UC-INB-005 — the contract announcement.md consumes, and the only one that
 * crosses this module's facade.
 *
 * `titleParams` carries **`subject`**: the announcement's own title, which this
 * module renders into "Perlu konfirmasi baca · …". announcement.md fixes that
 * the parameter exists and not what is in it, because the copy is this module's
 * (`titles.ts`) and that module holds no string of ours.
 *
 * Neither method returns a `Result`. There is no business failure a caller can
 * act on: a retraction that closes nothing has simply already been retracted,
 * and a fan-out to a user id that does not exist is a foreign key violation and
 * therefore a defect in the caller.
 */
export interface InboxPort {
  /** BR-INB-009's `dueAt` is the announcement's `acknowledge_by`, and optional. */
  createAckItems(command: CreateAckItemsCommand): Promise<AckItemsReport>;
  /** BR-INB-002 — open items close `retracted`; `done` ones are history. */
  closeAckItems(announcementId: string): Promise<number>;
}

export const INBOX_OUTBOX = Symbol('INBOX_OUTBOX');

/** §12's one emitted event (naming §6), named rather than typed loose. */
export type InboxEventName = 'inbox.item.acknowledged';

export interface InboxOutboxPort {
  emit(event: {
    name: InboxEventName;
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
