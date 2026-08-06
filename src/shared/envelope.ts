/**
 * The ADR-0007 response envelope. Two shapes, no third, and no other top-level
 * key ever. `meta` is absent when empty rather than `{}` — the ADR's wording.
 */
export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorDetailEntry {
  field: string;
  code: string;
  messageKey: string;
  params?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    messageKey: string;
    details?: ErrorDetailEntry[] | Record<string, unknown>;
    requestId: string;
  };
}

/** Offset pagination `meta` (ADR-0007). */
export interface OffsetMeta extends Record<string, unknown> {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Cursor pagination `meta` (ADR-0007), arriving with its first feed — the audit
 * log. **Never a total**: api-standards §5.4 makes that a rule rather than an
 * omission, because a count alongside a keyset feed is a second full scan of the
 * table the cursor style exists to avoid scanning.
 */
export interface CursorMeta extends Record<string, unknown> {
  nextCursor: string | null;
  hasMore: boolean;
}
