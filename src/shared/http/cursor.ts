import { AppErrorException } from '../unwrap';
import { sharedErrors } from '../shared.errors';

/**
 * Opaque keyset cursors (api-standards §5.3, ADR-0007).
 *
 * "Opaque" is a contract, not a hint: clients never construct or parse one, so
 * the encoding is free to change and the only thing that must hold is that a
 * cursor this process emitted round-trips. Anything else — truncated, edited,
 * from another resource, or from a previous encoding — is `VAL_INVALID_CURSOR`
 * and the client restarts from page one.
 *
 * base64url and not base64: a cursor rides in a query string, and `+` there
 * decodes to a space.
 */
export interface KeysetPosition {
  /** ISO instant of the ordering column. */
  occurredAt: string;
  /** uuidv7 tiebreaker — same-millisecond inserts still order deterministically. */
  id: string;
}

export function encodeCursor(position: KeysetPosition): string {
  return Buffer.from(JSON.stringify([position.occurredAt, position.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): KeysetPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppErrorException(sharedErrors.invalidCursor());
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new AppErrorException(sharedErrors.invalidCursor());
  }
  const [occurredAt, id] = parsed as unknown[];
  if (typeof occurredAt !== 'string' || typeof id !== 'string') {
    throw new AppErrorException(sharedErrors.invalidCursor());
  }
  // A cursor that decodes to a non-date would otherwise reach the database as
  // `'garbage'::timestamptz` and surface as a 500 — the client's mistake wearing
  // the server's error code.
  if (Number.isNaN(Date.parse(occurredAt)) || !UUID.test(id)) {
    throw new AppErrorException(sharedErrors.invalidCursor());
  }

  return { occurredAt, id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
