import { createHash } from 'node:crypto';

import type { AuditLogRow } from './audit.ports';

/**
 * The tamper-evidence arithmetic of BR-AUD-009 / UC-AUD-005, as pure functions.
 *
 * Per-row hash chaining was rejected upstream because it serializes concurrent
 * writers on the chain head; the chain here is one link per *day*, which buys a
 * ≤ 24 h detection granularity in exchange for writers that never contend. That
 * tradeoff is the module's, not this file's — what lives here is only the
 * requirement that the same rows always produce the same digest, and that any
 * edit to any column of any row produces a different one.
 */

/** Anchor days are UTC, because the cron that computes them is (ADR-0010). */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The half-open uuidv7 range covering everything **inserted** on `day`.
 *
 * uuidv7 carries the insert millisecond in its leading 48 bits, so an id range
 * is an insert-time range — and unlike `occurred_at` it cannot be back-dated by
 * a late event fact. The boundary uuid is the smallest legal v7 value for that
 * millisecond: version nibble 7, variant nibble 8, every random bit zero.
 */
export function anchorDayRange(day: string): { fromId: string; toId: string } {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start)) throw new Error(`anchor day is not an ISO date: ${day}`);
  return { fromId: boundaryUuid(start), toId: boundaryUuid(start + DAY_MS) };
}

function boundaryUuid(epochMs: number): string {
  const hex = epochMs.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/**
 * One row's contribution. Every column is in it: a digest that ignored
 * `metadata` would certify a row whose `metadata` had been rewritten.
 */
export function rowHash(row: AuditLogRow): string {
  return sha256(
    JSON.stringify([
      row.id,
      row.occurredAt.toISOString(),
      row.actorType,
      row.actorUserId,
      row.impersonatorId,
      row.requestId,
      row.action,
      row.entityType,
      row.entityId,
      canonical(row.diff),
      canonical(row.metadata),
      row.eventId,
    ]),
  );
}

/**
 * `sha256(ordered row hashes + prev_digest)` (§4.1). Rows arrive in
 * `(occurred_at, id)` order and are not re-sorted here — the ordering is the
 * repository's `ORDER BY`, and duplicating it in two places is how the two
 * drift.
 *
 * The row count is folded in so that an empty day still chains, and so that
 * deleting a row cannot be masked by inserting another.
 */
export function computeDigest(rows: readonly AuditLogRow[], prevDigest: string | null): string {
  const hashes = rows.map(rowHash);
  return sha256(JSON.stringify([prevDigest, hashes.length, hashes]));
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * jsonb round-trips with its own key order, and `JSON.stringify` is order
 * sensitive, so the same stored value could hash two ways across a dump and
 * restore. A false "tamper detected" costs an investigation; sorting keys costs
 * nothing.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return entries.map(([key, nested]) => [key, canonical(nested)]);
}
