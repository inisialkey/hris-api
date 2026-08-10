/**
 * BR-IMP-001, the platform law: *"Definitions are code-owned … modules register
 * `ImportDefinition`/`ExportDefinition` in code + their doc §13 + this doc's
 * §4.3 table, same session. No tenant-built mappings."*
 *
 * So this file owns the **protocol** and nothing else. §4.3's table lists thirty
 * definitions across twenty modules and not one of them is registered here —
 * each belongs to the module that owns its rows, on the `registerFileOwner`
 * relationship (document-storage §4.2) rather than the settings one: the owner
 * holds the permission key, the natural key, and the port that applies a row,
 * and none of those is this module's to decide.
 *
 * **A definition key with nothing registered against it is not live**, exactly as
 * an unowned file category is not live: `POST /imports` for it is a
 * `VAL_INVALID_ENUM`, and `GET /definitions` does not list it. That is what makes
 * registration the gate rather than a decoration (A-197's precedent, A-200).
 */

import type { Result } from '../../../shared/result';
import type {
  CellValue,
  ExportParams,
  LocalizedText,
  ParsedRow,
  RowError,
  RowVerdict,
} from './import-export.types';

export type ImportColumnType = 'string' | 'date' | 'decimal' | 'integer' | 'boolean' | 'enum';

/**
 * A single column's rule, run after coercion and only on a non-null value —
 * `required` already answers absence, and a validator asked to re-answer it is
 * a second place the same condition can disagree.
 */
export type ColumnValidator = (value: CellValue, row: ParsedRow) => RowError | null;

/**
 * §4.3's `crossRowValidators` — *"in-file dupes, aggregate checks"*.
 *
 * Natural-key duplicate detection is **not** one of these: `naturalKey` already
 * declares the identity, so the framework runs that check for every definition
 * rather than leaving thirty modules to remember it (§9's *"two rows, same NIK …
 * never last-writer-wins silently"*). What is left here is the genuinely
 * definition-specific case, of which `performance.goal`'s per-employee weight
 * balance is the registry's example.
 */
export type CrossRowValidator = (rows: readonly ParsedRow[]) => readonly RowVerdict[];

export interface ImportColumn {
  readonly key: string;
  readonly header: LocalizedText;
  readonly type: ImportColumnType;
  /** Required for `enum`, rejected on every other type. */
  readonly enumValues?: readonly string[];
  readonly required: boolean;
  readonly validators?: readonly ColumnValidator[];
  /** UC-IMP-005's *"one example row"*. */
  readonly example?: string;
}

/**
 * The module port that applies one row — §4.3's `rowHandler`, and the seam that
 * keeps domain logic in the module that owns it (ADR-0001 rule 2).
 *
 * Two methods rather than one, because BR-IMP-002 makes dry-run and commit *"the
 * same validation code path"* and half of every definition's validation needs a
 * database: existence of a `company_code`, the attendance period lock, whether
 * the employee already holds a package. `check` is that half and is run in both
 * passes; `apply` writes and is run only at commit.
 */
export interface ImportRowHandler {
  /**
   * Row-level checks that need the database. Runs inside the caller's
   * transaction, in both passes, and writes nothing.
   */
  check?(row: ParsedRow): Promise<readonly RowError[]>;
  /**
   * Applies one validated row inside the caller's transaction. A business
   * refusal is a `fail` whose code lands in the error report as that row's
   * verdict — never a throw, which would take the batch with it (§9's
   * *"row handler throws unexpectedly (bug, not validation)"* is the other case
   * and is deliberately not this one).
   */
  apply(row: ParsedRow): Promise<Result<void>>;
}

export interface ImportDefinition {
  /** `<ns>.<subject>` — `employee.master`, `holiday.calendar` (naming §4). */
  readonly key: string;
  readonly requiredPermission: string;
  /** BR-IMP-006 — bumped by any column change. */
  readonly templateVersion: number;
  readonly columns: readonly ImportColumn[];
  readonly crossRowValidators?: readonly CrossRowValidator[];
  /** Upsert identity; empty is legal (`leave.balance_adjustment` has none). */
  readonly naturalKey: readonly string[];
  readonly writeMode: 'create_only' | 'upsert' | 'update_only';
  readonly commitMode: 'partial' | 'strict';
  readonly rowHandler: ImportRowHandler;
}

export interface ExportColumn {
  readonly key: string;
  readonly header: LocalizedText;
}

export interface GatedColumnSet {
  readonly permission: string;
  readonly columns: readonly ExportColumn[];
}

export interface ColumnSets {
  readonly base: readonly ExportColumn[];
  readonly gated?: readonly GatedColumnSet[];
}

export type ParamType = 'string' | 'uuid' | 'date' | 'integer' | 'boolean' | 'enum';

export interface ParamSpec {
  readonly key: string;
  readonly type: ParamType;
  readonly required: boolean;
  readonly enumValues?: readonly string[];
}

/** A row as the query port yields it, keyed by the definition's column keys. */
export type ExportRow = Readonly<Record<string, string | number | boolean | null>>;

export interface ExportQueryPort {
  /**
   * A cursor, not a page. ADR-0015 fixes *"streaming query (internal cursor) →
   * streaming writer"* precisely so a ten-thousand-row export never materializes
   * as an array; an implementation that assembles one and yields it defeats the
   * bound and is a review blocker rather than a slow path.
   */
  stream(params: ExportParams): AsyncIterable<ExportRow>;
}

/**
 * §4.3's *definition-resolved* amendment (2026-08-03, reports.md), which lets one
 * registry row stand for a consumer registry's worth of definitions: *"a
 * definition may declare its permission, columns, and query port as resolved
 * from a consumer registry keyed by one of its own params"*.
 *
 * Resolution runs at enqueue, before the permission check and before BR-IMP-010
 * freezes the entitlement, so nothing downstream changes. `report.result` is the
 * only declared user and reports.md is not built, so no definition uses this
 * today — it exists because without it that module could not register at all,
 * its ninety-three permissions and column sets being a function of `reportKey`.
 */
export interface ResolvedExport {
  readonly requiredPermission: string;
  readonly columnSets: ColumnSets;
  readonly queryPort: ExportQueryPort;
}

export interface ExportDefinition {
  readonly key: string;
  /** Ignored when `resolve` is present — the resolver answers instead. */
  readonly requiredPermission: string;
  readonly params: readonly ParamSpec[];
  readonly columnSets: ColumnSets;
  readonly queryPort: ExportQueryPort;
  readonly resolve?: (params: ExportParams) => Promise<ResolvedExport>;
}

const imports = new Map<string, ImportDefinition>();
const exports_ = new Map<string, ExportDefinition>();

/** naming §4: `<ns>.<subject>`, lowercase, one dot-separated pair or more. */
const KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_]*)+$/;

export function registerImportDefinition(definition: ImportDefinition): void {
  assertKey(definition.key);
  assertUnclaimed(imports, definition.key, 'import');
  if (definition.columns.length === 0) {
    throw new Error(`import definition ${definition.key} declares no columns`);
  }

  const keys = new Set<string>();
  for (const column of definition.columns) {
    if (keys.has(column.key)) {
      throw new Error(`import definition ${definition.key} declares column ${column.key} twice`);
    }
    keys.add(column.key);
    // An enum column with no values accepts everything, which is the one failure
    // an `enum` type exists to prevent — and a whitelist on a `string` column is
    // a rule somebody wrote in the wrong field.
    if (column.type === 'enum' && (column.enumValues?.length ?? 0) === 0) {
      throw new Error(`import column ${definition.key}.${column.key} is enum with no values`);
    }
    if (column.type !== 'enum' && column.enumValues) {
      throw new Error(
        `import column ${definition.key}.${column.key} declares enumValues on a ${column.type}`,
      );
    }
  }

  for (const part of definition.naturalKey) {
    if (!keys.has(part)) {
      // A natural key naming a column the template does not carry is an identity
      // nothing can be checked against — every row would look unique.
      throw new Error(`import definition ${definition.key} keys on unknown column ${part}`);
    }
  }

  imports.set(definition.key, definition);
}

export function registerExportDefinition(definition: ExportDefinition): void {
  assertKey(definition.key);
  assertUnclaimed(exports_, definition.key, 'export');
  if (definition.columnSets.base.length === 0 && !definition.resolve) {
    throw new Error(`export definition ${definition.key} declares no base columns`);
  }
  for (const spec of definition.params) {
    if (spec.type === 'enum' && (spec.enumValues?.length ?? 0) === 0) {
      throw new Error(`export param ${definition.key}.${spec.key} is enum with no values`);
    }
  }
  exports_.set(definition.key, definition);
}

/** Test seam only — the registry is process-global by design. */
export function clearDefinitions(): void {
  imports.clear();
  exports_.clear();
}

export function findImportDefinition(key: string): ImportDefinition | null {
  return imports.get(key) ?? null;
}

export function findExportDefinition(key: string): ExportDefinition | null {
  return exports_.get(key) ?? null;
}

export function listImportDefinitions(): ImportDefinition[] {
  return [...imports.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function listExportDefinitions(): ExportDefinition[] {
  return [...exports_.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Every column a requester is entitled to, in declaration order — base first,
 * then each gated set whose permission they hold (BR-IMP-010).
 *
 * Order is part of the contract rather than an accident: two people exporting
 * the same definition get files whose shared columns sit in the same places, so
 * a downstream spreadsheet formula does not depend on who ran it.
 */
export function entitledColumns(
  sets: ColumnSets,
  held: ReadonlySet<string>,
): { columns: ExportColumn[]; gated: boolean } {
  const columns = [...sets.base];
  let gated = false;
  for (const set of sets.gated ?? []) {
    if (!held.has(set.permission)) continue;
    columns.push(...set.columns);
    gated = true;
  }
  return { columns, gated };
}

function assertKey(key: string): void {
  if (!KEY.test(key)) {
    throw new Error(`definition key ${key} is not <ns>.<subject> (naming §4)`);
  }
}

function assertUnclaimed(registry: Map<string, unknown>, key: string, kind: string): void {
  // Two modules claiming one key is two answers to "who may run this and what
  // does a row mean" — and the wrong one would be whichever module loaded last.
  if (registry.has(key)) {
    throw new Error(`${kind} definition ${key} is already registered`);
  }
}
