import type { Readable, Writable } from 'node:stream';

import type { CategoryUsage, EntityRef, FileRow, FileStatus } from './document.types';

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
  /**
   * UC-DOC-004's write half — bytes straight to the final path, no staging,
   * because they never left the server. The `Writable` is what a generator
   * (exceljs, Puppeteer) pipes into; the caller never assembles a buffer, which
   * is what keeps a ten-thousand-row workbook inside a bounded footprint
   * (ADR-0015).
   */
  openWrite(path: string, mime: string): Writable;
  /**
   * The server-side read half. **Not a client path**: ADR-0009's *"the API never
   * proxies bytes"* binds the metadata plane between a client and storage, and
   * this is a worker parsing a file it was asked to import (UC-IMP-002). Nothing
   * here reaches an HTTP response.
   */
  openRead(path: string): Readable;
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
  /**
   * UC-IMP-001's re-parent. A slot is requested before the job that will own the
   * file exists, so it is parented to the uploader; the job creation moves it in
   * the same transaction. Narrow on purpose — the entity moves and nothing else,
   * because a method that could also change the category would be a way around
   * the registry.
   */
  reparent(id: string, ref: EntityRef): Promise<FileRow | null>;
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

export const DOCUMENT_PORT = Symbol('DOCUMENT_PORT');

export interface GeneratedFileCommand {
  readonly category: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly fileName: string;
  readonly mime: string;
}

/**
 * **UC-DOC-004's port, declared 2026-08-10 with its first caller**
 * (A-200, hris-handbook PR #34, import-export). The facade's own comment named the condition for it: four
 * module documents ask for a `DocumentPort`, none declares its shape, and a port
 * whose methods only its first caller can define is the one employee withheld as
 * `EmployeePayrollPort` (A-195). import-export is that caller, and it defines
 * all four methods precisely.
 *
 * UC-DOC-004 in one sentence — *"workers write objects directly to the final
 * path via the GCS SDK and insert `committed` rows in the same unit of work (no
 * staging — bytes never left the server)"* — plus the two reads a job needs
 * around it, and the re-parent UC-IMP-001 requires.
 *
 * **No download minting here.** That stays on `GET /documents/{id}/download-url`
 * where the gate and the sensitive-read trail live (UC-DOC-003); a port that
 * minted URLs would be a second access path with none of it.
 */
export interface DocumentPort {
  /**
   * Streams whatever `write` produces into the final path, hashing and counting
   * as it goes, and returns the `committed` metadata row. The digest and the
   * size are measured rather than declared — there is no uploader to distrust
   * here, but `files.sha256` means "these bytes" and only a measurement says so.
   */
  storeGenerated(
    command: GeneratedFileCommand,
    write: (sink: Writable) => Promise<void>,
  ): Promise<FileRow>;
  /** `null` for an unknown, deleted, or still-staged file. */
  find(fileId: string): Promise<FileRow | null>;
  /** Bytes of a committed file, for a worker that parses them. */
  openContent(fileId: string): Promise<Readable | null>;
  reparent(fileId: string, ref: EntityRef): Promise<void>;
  /**
   * Retires a file the calling module generated or owns, releasing it to
   * `cron.document.purge` (BR-DOC-009's object-then-row collection).
   *
   * Deliberately **not** gated by `clientDeletable`: that flag answers *"may a
   * user delete this"* on UC-DOC-005's endpoint, and `import_file` sets it false
   * precisely because a job artifact is not a user's to remove. The module whose
   * retention window just expired is a different actor, and import-export §12's
   * purge is explicit that it collects its stored files *"via document-storage"*.
   */
  softDelete(fileId: string): Promise<void>;
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
