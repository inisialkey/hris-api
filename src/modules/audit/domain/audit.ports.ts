/**
 * Audit's ports (audit-log.md §4).
 *
 * The module has **no write API** — §2 says so outright, and BR-AUD-001 makes it
 * structural by revoking UPDATE/DELETE from `hris_app`. Rows arrive through
 * three channels instead: the same-transaction repository hook (BR-AUD-002),
 * consumed event facts (BR-AUD-003), and the explicit sensitive-read call below
 * (BR-AUD-007). Only the third exists today; the other two are named in the
 * module's README-level note and in the handbook assumption that records the gap.
 */

export type AuditActorType = 'user' | 'system' | 'platform_op';

/** BR-AUD-005's shape: a masked column records that it changed, never the value. */
export interface AuditDiff {
  changed: Record<string, { before: unknown; after: unknown } | { masked: true }>;
}

export interface NewAuditLog {
  tenantId: string;
  /**
   * Omitted means the database's `now()`, which §9 requires: `occurred_at` is
   * one clock for every pod, and a `Date` minted in the process would put pod
   * skew straight into the cursor's ordering column. Channel 2 is the exception
   * that makes the field exist — a consumed fact carries *its* time, not the
   * time it was finally consumed.
   */
  occurredAt?: Date;
  actorType: AuditActorType;
  actorUserId?: string;
  impersonatorId?: string;
  requestId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  diff?: AuditDiff;
  metadata?: Record<string, unknown>;
  eventId?: string;
}

export interface AuditLogRow {
  id: string;
  occurredAt: Date;
  actorType: AuditActorType;
  actorUserId: string | null;
  impersonatorId: string | null;
  requestId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  diff: AuditDiff | null;
  metadata: Record<string, unknown> | null;
  eventId: string | null;
}

/** UC-AUD-004's filter set, verbatim from §7's query string. */
export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  /** Prefix match — `action=leave.` reads a module's whole trail. */
  action?: string;
  actorType?: AuditActorType;
  /** `[from, to)`, ISO instants. */
  from?: Date;
  to?: Date;
}

export interface KeysetCursor {
  occurredAt: Date;
  id: string;
}

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');

export interface AuditRepositoryPort {
  append(entry: NewAuditLog): Promise<string>;
  findById(id: string): Promise<AuditLogRow | null>;
  /**
   * Newest first, keyset on `(occurred_at, id)`. Returns at most `limit` rows
   * plus a `hasMore` flag — never a total, per api-standards §5.4.
   */
  list(
    filter: AuditLogFilter,
    page: { limit: number; after?: KeysetCursor },
  ): Promise<{ rows: AuditLogRow[]; hasMore: boolean }>;
  /**
   * The day's rows in `(occurred_at, id)` order, selected by **insert** time
   * (the uuidv7 id range), which is what makes a late channel-2 row anchor on
   * the day it landed rather than the day it happened (UC-AUD-005).
   */
  listForAnchorDay(day: string): Promise<AuditLogRow[]>;
}

export interface AnchorRecord {
  day: string;
  rowCount: number;
  digest: string;
  prevDigest: string | null;
}

export const AUDIT_ANCHOR_REPOSITORY = Symbol('AUDIT_ANCHOR_REPOSITORY');

export interface AuditAnchorRepositoryPort {
  findByDay(day: string): Promise<AnchorRecord | null>;
  /** The chain link: the newest anchor strictly before `day`. */
  findPreviousDigest(day: string): Promise<string | null>;
  insert(tenantId: string, anchor: AnchorRecord): Promise<void>;
}

export const AUDIT_PORT = Symbol('AUDIT_PORT');

/**
 * The one call other modules make (BR-AUD-007). Registered read keys live in
 * §4.3; a caller invents neither the key nor the moment — it fires at the access
 * point, which for a file is the URL mint and for a field is the reveal.
 *
 * **Fail-closed**: the insert precedes the response, and a failure refuses the
 * read (UC-AUD-003). A read audit that can be dropped is not an access record.
 */
export interface AuditPort {
  sensitiveRead(
    actionKey: string,
    entityType: string,
    entityId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}
