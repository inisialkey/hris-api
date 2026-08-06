/**
 * `JSON.stringify` with object keys sorted, recursively.
 *
 * Exists because **jsonb does not round-trip key order**: PostgreSQL stores an
 * object by its own ordering, so `{ min: 1, max: 300 }` comes back as
 * `{ max: 300, min: 1 }` and a plain `JSON.stringify` comparison calls the value
 * changed when nothing changed. Two places care and they care for the same
 * reason — the audit anchor must not report tampering after a dump and restore
 * (BR-AUD-009), and the settings definition sync must not rewrite every row on
 * every release (UC-SET-006).
 *
 * Arrays keep their order: in an array, order *is* content.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => [key, canonical(nested)]);
}
