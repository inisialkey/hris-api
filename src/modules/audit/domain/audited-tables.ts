/**
 * The audited-table registry of audit-log §4.2, and BR-AUD-005's masker.
 *
 * §4.2 is a document; this is the same registry as code, and the amendment of
 * 2026-08-06 is explicit that it **fails loud**: a table audited without an entry
 * throws when its repository is constructed, rather than defaulting to a full
 * diff. A table nobody classified is a table nobody thought about, and the
 * failure belongs at startup rather than in a diff that already shipped.
 *
 * Modules register their own tables beside their error block — one call in the
 * module file, the `registerErrorStatuses` shape — because §4.2's protocol is
 * that the module declaring an audited table appends to the registry in the same
 * session.
 */

import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import { stableStringify } from '../../../shared/stable-json';
import type { AuditDiff } from './audit.ports';

export type AuditChangeAction = 'created' | 'updated' | 'deleted';

export interface AuditedTableEntry {
  /**
   * §4.2's masking note for this table, as column names — BR-AUD-005 layer 3,
   * the operative list. Empty is the common and correct case: "no sensitive
   * columns; full diffs" is what most of the registry says, and a column matched
   * by no layer diffs in full deliberately, because an audit row that omits what
   * changed is not evidence.
   */
  maskedColumns?: readonly string[];
}

const registry = new Map<string, ReadonlySet<string>>();

/**
 * BR-AUD-005 layer 2 — the floor.
 *
 * Credential and token material never enters a diff on any table, whatever that
 * table's note says: it carries no evidentiary value the action key does not
 * already carry. Drawn from security-standards §10's auth cluster and nothing
 * else — §10 is a *telemetry* registry and the rest of it (money, `ptkp_status`,
 * NIK) answers a different question than an audit diff does.
 *
 * Matched against the **column** name, snake_case, case-insensitively.
 */
const CREDENTIAL_FLOOR = /(password|^pin$|_pin$|token|authorization|cookie|secret)/i;

/**
 * Columns excluded from every diff because the audit row already carries them,
 * more precisely than the column does: `occurred_at` is one clock for every pod,
 * and `actor_user_id` + `impersonator_id` are two identities where `updated_by`
 * is one. `id` is the row's `entity_id` and `tenant_id` is what it is filed
 * under. Repeating any of them would make the diff longer without making it say
 * anything.
 */
const METADATA_COLUMNS = new Set([
  'id',
  'tenant_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'deleted_at',
  'deleted_by',
]);

export function registerAuditedTables(entries: Readonly<Record<string, AuditedTableEntry>>): void {
  for (const [table, entry] of Object.entries(entries)) {
    const masked = new Set((entry.maskedColumns ?? []).map((column) => column.toLowerCase()));
    const existing = registry.get(table);
    if (existing && stableStringify([...existing].sort()) !== stableStringify([...masked].sort())) {
      // Two modules claiming one table with two masking notes is §4.2's
      // one-owner rule broken at runtime. Fail at boot, not at the first diff.
      throw new Error(`audited table ${table} already registered with a different masking note`);
    }
    registry.set(table, masked);
  }
}

/** Test seam only — the registry is process-global by design. */
export function clearAuditedTables(): void {
  registry.clear();
}

/**
 * The fail-loud gate. Called when a `TenantScopedRepository` is constructed, so
 * an unregistered audited table stops the process at module init.
 */
export function assertAuditedTable(table: string): void {
  if (!registry.has(table)) {
    throw new Error(
      `table ${table} is audited but has no audit-log §4.2 registry entry — register it in the owning module`,
    );
  }
}

export function isAuditedTable(table: string): boolean {
  return registry.has(table);
}

/**
 * BR-AUD-005, all three layers, in order.
 *
 * Layer 1 is derived rather than listed: an ADR-0016 `encryptedText` column masks
 * because of what it *is*, which is why `employees.npwp` masks while
 * `companies.npwp` diffs in full — same name, right answer both times, no list to
 * keep in sync. `encryptedText` is Drizzle's `customType`, and a custom type is
 * the only thing in this schema that reports `PgCustomColumn`; if a second custom
 * type ever arrives, this check tightens to name it.
 */
function isMasked(table: string, column: string, definition: PgColumn | undefined): boolean {
  if (definition?.columnType === 'PgCustomColumn') return true; // layer 1
  if (CREDENTIAL_FLOOR.test(column)) return true; // layer 2
  return registry.get(table)?.has(column.toLowerCase()) ?? false; // layer 3
}

/**
 * §4.2's protocol: INSERT → `created` (after only), UPDATE → `updated`
 * (changed-column diff), soft/hard DELETE → `deleted` (before only).
 *
 * One marker for all three masking layers — `{ masked: true }` — because §4.2's
 * prose `[encrypted]` and `[redacted]` say *why* a column is masked and are not a
 * second and third wire format (BR-AUD-005, amended 2026-08-06).
 */
export function buildChangeDiff(
  table: PgTable,
  action: AuditChangeAction,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): AuditDiff {
  const name = getTableName(table);
  const columns = getTableColumns(table);
  const changed: AuditDiff['changed'] = {};

  for (const [property, definition] of Object.entries(columns)) {
    const column = definition.name;
    if (METADATA_COLUMNS.has(column)) continue;

    const previous = action === 'created' ? undefined : before?.[property];
    const next = action === 'deleted' ? undefined : after?.[property];
    if (action === 'updated' && !differs(previous, next)) continue;
    if (action === 'created' && next === undefined) continue;
    if (action === 'deleted' && previous === undefined) continue;

    changed[column] = isMasked(name, column, definition)
      ? { masked: true }
      : { before: serialize(previous), after: serialize(next) };
  }

  return { changed };
}

/**
 * jsonb key order does not round-trip, and a `numeric` column arrives as a
 * string while the value written was a number — so equality is compared on the
 * canonical serialization rather than on the raw values.
 */
function differs(before: unknown, after: unknown): boolean {
  if (after === undefined) return false; // a patch that does not mention the column
  return stableStringify(serialize(before)) !== stableStringify(serialize(after));
}

function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
