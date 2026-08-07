/**
 * The category registry of document-storage §4.2, split the way §2 splits it.
 *
 * **The policy half is this module's and is a contract** — mimes, size ceiling,
 * URL TTL, client-deletability, retention class. §4.2's table is the seed and
 * every row of it is below, including the seven whose owning module does not
 * exist yet: a ceiling is a platform decision and it does not become one later.
 *
 * **The authorization half belongs to the owning module and arrives by
 * registration** — the `registerAuditedTables` shape, one call in the owning
 * module file. §2 says file authorization is *delegated to the owning category*
 * and that this module has no standalone permission keys, so there is nothing
 * here to check against; the owner answers.
 *
 * A category with no owner is **not live**: `POST /documents/uploads` for it is a
 * 404 rather than an unguarded upload. That is what makes registration the gate
 * rather than a decoration.
 */

import { DOCX, XLSX } from './mime';
import type { EntityRef, FileRow } from './document.types';

const PDF = 'application/pdf';
const JPEG = 'image/jpeg';
const PNG = 'image/png';
const MB = 1024 * 1024;

/** Common client-attachment set: a scan, a photo, or a screenshot. */
const SCAN_MIMES = [PDF, JPEG, PNG] as const;

/**
 * How `cron.document.purge` may collect a category (§12, BR-DOC-009/010).
 *
 * `statutory` is the class database-conventions §4.4 puts at ten years with
 * payroll; this job never touches those rows and the class is named rather than
 * given a number, because the number is a retention policy and not this
 * module's to type.
 */
export type RetentionPolicy =
  | { kind: 'none' }
  | { kind: 'statutory' }
  /** Purged this long after the row was soft-deleted. */
  | { kind: 'after_delete'; settingKey: string; unit: 'days' | 'months' }
  /** Purged this long after the object was created, deleted or not (A-008). */
  | { kind: 'after_create'; settingKey: string; unit: 'days' | 'months' };

export interface CategoryPolicy {
  readonly allowedMimes: readonly string[];
  /**
   * The ceiling; a tenant setting may only tighten it (BR-DOC-007).
   *
   * `null` is §4.2's *"— (worker-only)"* and it means there is no client upload
   * path at all, not that the size is unbounded. A slot request for such a
   * category is refused before any cap arithmetic happens.
   */
  readonly maxSizeBytes: number | null;
  readonly sizeSettingKey?: string;
  readonly downloadUrlTtlSeconds: number;
  readonly clientDeletable: boolean;
  readonly expiryReminders: boolean;
  readonly retention: RetentionPolicy;
  /**
   * §12's fail-closed access record, when every mint of the category is one.
   * `import_file` is the other case and is not here: whether an export output
   * carries gated columns is a per-file fact, so its owner answers it
   * (`FileOwner.sensitiveReadKey`).
   */
  readonly sensitiveReadKey?: string;
}

/**
 * The authorization half, supplied by the module that owns the category.
 *
 * §2's two gates — *"category permission **+** ownership resolver"* — are one
 * predicate here rather than two fields, because half of §4.2's rows state a
 * gate no static permission key can express: *"self, or `expense.claim.create`"*,
 * *"or a live approver of its instance"*, *"while the claim is `draft` or
 * `returned`"*. Splitting them would put the expressible half in the registry
 * and leave the rest unenforced (A-197, hris-handbook PR #31).
 *
 * Every predicate answers **false**, never an error: §2 says a scope miss is 404
 * and existence hiding is the whole reason this module has no permission keys of
 * its own.
 */
export interface FileOwner {
  /** `files.module` — the owning namespace (naming §4). */
  readonly module: string;
  /** Entity types this owner resolves; anything else is not its file. */
  readonly entityTypes: readonly string[];
  /** May the caller attach a file of this category to this entity? */
  canWrite(ref: EntityRef): Promise<boolean>;
  canRead(ref: EntityRef): Promise<boolean>;
  /** The state half of `clientDeletable` — the platform half is the policy above. */
  canDelete(ref: EntityRef): Promise<boolean>;
  /**
   * §12's `document.download.gated_export` hook. Returns the registered read key
   * when *this* file's mint is a sensitive read, or null when it is not.
   */
  sensitiveReadKey?(file: FileRow): Promise<string | null>;
}

export interface Category extends CategoryPolicy {
  readonly key: string;
  readonly owner: FileOwner;
}

/** §4.2's seed table, verbatim. */
export const CATEGORY_POLICIES: Readonly<Record<string, CategoryPolicy>> = {
  punch_selfie: {
    allowedMimes: [JPEG],
    maxSizeBytes: 1 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: false,
    expiryReminders: false,
    retention: {
      kind: 'after_create',
      settingKey: 'attendance.selfie_retention_months',
      unit: 'months',
    },
  },
  employee_document: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    sizeSettingKey: 'document.employee_document_max_size_mb',
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: true,
    retention: { kind: 'none' },
  },
  receipt: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    sizeSettingKey: 'document.receipt_max_size_mb',
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: false,
    retention: { kind: 'none' },
  },
  generated_document: {
    allowedMimes: [PDF],
    // §4.2's "— (worker-only)": UC-DOC-004 writes these straight to the final
    // path, bytes never having left the server, so there is no declared size to
    // bound and no cap to invent.
    maxSizeBytes: null,
    downloadUrlTtlSeconds: 120,
    clientDeletable: false,
    expiryReminders: false,
    retention: { kind: 'statutory' },
    sensitiveReadKey: 'document.download.generated_document',
  },
  import_file: {
    allowedMimes: [XLSX],
    maxSizeBytes: 20 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: false,
    expiryReminders: false,
    retention: { kind: 'none' },
  },
  candidate_file: {
    allowedMimes: [PDF, DOCX],
    maxSizeBytes: 10 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: false,
    retention: {
      kind: 'after_delete',
      settingKey: 'recruitment.candidate_retention_days',
      unit: 'days',
    },
  },
  asset_document: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: false,
    retention: { kind: 'none' },
  },
  training_certificate: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    // Turned off 2026-08-03 (training.md BR-TRN-013): the credential row owns
    // `expires_on` and training's own cron reminds against it, because a
    // certification exists before its scan does and may never get one.
    expiryReminders: false,
    retention: { kind: 'none' },
  },
  announcement_attachment: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: false,
    // Follows the post's two keys rather than a category key: an attachment has
    // no reason to outlive the announcement it belonged to, so
    // `cron.announcement.purge` soft-deletes it and this job collects it.
    retention: { kind: 'none' },
  },
  leave_attachment: {
    allowedMimes: SCAN_MIMES,
    maxSizeBytes: 10 * MB,
    downloadUrlTtlSeconds: 600,
    clientDeletable: true,
    expiryReminders: false,
    retention: { kind: 'none' },
  },
};

const owners = new Map<string, FileOwner>();

/**
 * Called once from the owning module's file, beside its error block. Fails loud
 * on a second claim: two modules owning one category is two answers to *"may I
 * read this"* and the wrong one would be whichever loaded last.
 */
export function registerFileOwner(category: string, owner: FileOwner): void {
  if (!(category in CATEGORY_POLICIES)) {
    throw new Error(`file category ${category} has no document-storage §4.2 policy`);
  }
  const existing = owners.get(category);
  if (existing && existing !== owner) {
    throw new Error(`file category ${category} already owned by module ${existing.module}`);
  }
  owners.set(category, owner);
}

/** Test seam only — the registry is process-global by design. */
export function clearFileOwners(): void {
  owners.clear();
}

/** `null` for an unknown key and for a key nobody owns — both are "not live". */
export function findCategory(key: string): Category | null {
  const policy = CATEGORY_POLICIES[key];
  const owner = owners.get(key);
  return policy && owner ? { key, ...policy, owner } : null;
}

/**
 * Every live category whose owner claims this entity type — §7's list endpoint
 * takes an entity and not a category, so the entity is what has to resolve.
 */
export function categoriesForEntityType(entityType: string): Category[] {
  return [...owners.entries()]
    .filter(([, owner]) => owner.entityTypes.includes(entityType))
    .map(([key, owner]) => ({ key, ...CATEGORY_POLICIES[key]!, owner }));
}
