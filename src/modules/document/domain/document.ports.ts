import type { CategoryUsage, FileRow, FileStatus } from './document.types';

export const STORAGE_PORT = Symbol('STORAGE_PORT');

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface SignUploadOptions {
  /** BR-DOC-002 — the PUT is constrained to this exact content type. */
  mime: string;
  /** …and to this size, which is the first of BR-DOC-005's three layers. */
  maxBytes: number;
  ttlSeconds: number;
}

/** What one pass over a staged object yields — BR-DOC-004's whole input. */
export interface StoredObject {
  sizeBytes: number;
  /** The sniff window (`HEAD_BYTES`), not the object. */
  head: Buffer;
  sha256: string;
}

/**
 * ADR-0009's bucket, behind a port.
 *
 * The API is on the **metadata plane** — it signs, it verifies at commit, and it
 * never proxies bytes to a client. `inspect` is the one place bytes are read
 * server-side, and it is what BR-DOC-004 asks for: existence, size, magic bytes
 * and a digest, in a single pass rather than three round trips.
 */
export interface StoragePort {
  signUpload(path: string, options: SignUploadOptions): Promise<SignedUrl>;
  signDownload(path: string, ttlSeconds: number): Promise<SignedUrl>;
  /** `null` when the object is absent — BR-DOC-004's first check. */
  inspect(path: string, headBytes: number): Promise<StoredObject | null>;
  exists(path: string): Promise<boolean>;
  move(from: string, to: string): Promise<void>;
  /** Idempotent: an object already gone is a purge that already ran. */
  remove(path: string): Promise<void>;
}

export const FILE_REPOSITORY = Symbol('FILE_REPOSITORY');

export interface NewFile {
  module: string;
  entityType: string;
  entityId: string;
  category: string;
  originalName: string;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  status: FileStatus;
  sha256?: string;
  uploadedBy?: string;
}

export interface CommitPatch {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
}

export interface FileRepositoryPort {
  create(file: NewFile): Promise<FileRow>;
  findById(id: string): Promise<FileRow | null>;
  /**
   * Committed, non-deleted, for one owner entity — §7's list, narrowed to the
   * categories the caller's owner already said yes to. Filtering in SQL rather
   * than after the page boundary is what keeps `meta.total` honest.
   */
  listByEntity(
    entityType: string,
    entityId: string,
    categories: readonly string[],
    page: Page,
  ): Promise<Paged<FileRow>>;
  commit(id: string, patch: CommitPatch): Promise<FileRow | null>;
  /** BR-DOC-004: a failed commit leaves the row staged and records why. */
  recordCommitFailure(id: string, code: string): Promise<void>;
  softDelete(id: string, at: Date, by?: string): Promise<FileRow | null>;
  hardDelete(id: string): Promise<void>;
  /** BR-DOC-008 — committed, expiring inside the window, never yet reminded. */
  dueForExpiryReminder(onOrBefore: string): Promise<FileRow[]>;
  stampExpiryReminded(id: string, at: Date): Promise<void>;
  /** BR-DOC-003 — staged rows older than the staging lifecycle. */
  staleStaged(createdBefore: Date): Promise<FileRow[]>;
  /** BR-DOC-009 — soft-deleted rows, oldest first, for the purge job. */
  softDeletedOnOrBefore(deletedAt: Date, limit: number): Promise<FileRow[]>;
  /** BR-DOC-010 — committed rows of one category created before a cutoff. */
  committedCreatedBefore(category: string, createdBefore: Date, limit: number): Promise<FileRow[]>;
  usageByCategory(): Promise<CategoryUsage[]>;
}

export const DOCUMENT_OUTBOX = Symbol('DOCUMENT_OUTBOX');

/** §12's two events. Pointers only (coding-standards-nestjs §7). */
export interface DocumentOutboxPort {
  emit(event: {
    name: 'document.file.committed' | 'document.file.deleted';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export const STORAGE_USAGE_PORT = Symbol('STORAGE_USAGE_PORT');

/**
 * §13, verbatim — the only port this module serves, and narrow in three ways.
 *
 * It takes no `tenantId` (multi-tenancy §1 rule 2: the tenant comes from
 * context, so a platform caller cannot aggregate the wrong one by argument), it
 * returns counts and bytes and never a name, owner, or path, and it is the whole
 * of what leaves this module — every other consumer goes through the signed-URL
 * flow, which is where the sensitive-read trail lives.
 */
export interface StorageUsagePort {
  usageByCategory(): Promise<CategoryUsage[]>;
}
