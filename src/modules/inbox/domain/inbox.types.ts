/** The two §4 enums, derived from the pgEnum values rather than restated. */
export type InboxItemType = 'approval_task' | 'acknowledgment';
export type InboxItemStatus = 'open' | 'done' | 'closed';

/**
 * §4's `closed_reason` vocabulary, closed as a union because the column is
 * `text`. The handbook chose `text` over a pgEnum and this is the other half of
 * that choice: nothing in the database rejects `'retracted '` with a trailing
 * space, so the only writer is typed instead.
 */
export type ClosedReason =
  | 'superseded'
  | 'instance_approved'
  | 'instance_rejected'
  | 'instance_returned'
  | 'instance_cancelled'
  | 'retracted';

/** D12's two, same as notification's. `id` is the default — see `locale.ts`. */
export type Locale = 'id' | 'en';

/** Interpolation values only; scalars, for `render`'s reason. */
export type TitleParams = Record<string, string | number>;

/** §4's `source_ref`, both arms. */
export interface ApprovalSourceRef {
  instanceId: string;
  stepId: string;
  assigneeId: string;
  requestType: string;
  requestId: string;
}

export interface AcknowledgmentSourceRef {
  announcementId: string;
}

export type SourceRef = ApprovalSourceRef | AcknowledgmentSourceRef;

export interface InboxItemRow {
  id: string;
  userId: string;
  type: InboxItemType;
  status: InboxItemStatus;
  dedupeKey: string;
  title: string;
  subtitle: string | null;
  params: TitleParams;
  sourceRef: SourceRef;
  deepLink: string;
  dueAt: Date | null;
  seenAt: Date | null;
  doneAt: Date | null;
  closedReason: ClosedReason | null;
  createdAt: Date;
}

/**
 * §7's list row. `sourceRef` is absent deliberately — §7 does not list it, and
 * the ids inside it address other modules' rows, which a client reaches through
 * `deepLink` rather than by assembling a path from parts.
 */
export interface InboxListItem {
  id: string;
  type: InboxItemType;
  status: InboxItemStatus;
  title: string;
  subtitle: string | null;
  deepLink: string;
  dueAt: Date | null;
  seenAt: Date | null;
  doneAt: Date | null;
  closedReason: ClosedReason | null;
  /** §7's `delegateOf?` — the name, snapshotted at creation (BR-INB-005). */
  delegateOf: string | null;
  createdAt: Date;
}

/** Keyset position for the §7 cursor list: newest first, id as tiebreaker. */
export interface InboxCursor {
  createdAt: Date;
  id: string;
}

export interface InboxListQuery {
  limit: number;
  after?: InboxCursor;
  type?: InboxItemType;
  /** §7 defaults to `open`; the controller applies the default, not the query. */
  status: InboxItemStatus;
}

/**
 * UC-INB-005's port command. An object rather than §5's five positional
 * arguments: the packaging of a call is not the handbook's to fix (ADR-0025 §3),
 * and a five-argument call with an optional in the tail is the shape that breaks
 * on the next addition — which this signature has already had once, when
 * announcement.md's arrival added `dueAt`.
 */
export interface CreateAckItemsCommand {
  announcementId: string;
  userIds: readonly string[];
  /** Rendered into this module's acknowledgment title (BR-INB-005). */
  titleParams: TitleParams;
  deepLink: string;
  dueAt?: Date;
}

export interface AckItemsReport {
  created: number;
  deduped: number;
}
