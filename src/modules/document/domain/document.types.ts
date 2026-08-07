/**
 * The module's own vocabulary. Hand-written rather than derived from the Drizzle
 * enum for the reason coding-standards-nestjs §5 gives: a row type is
 * infrastructure and the domain should not import one to describe itself.
 */

export type FileStatus = 'staged' | 'committed' | 'quarantined';

/** The polymorphic owner every file hangs from (§4.1). */
export interface EntityRef {
  entityType: string;
  entityId: string;
}

export interface FileRow {
  id: string;
  module: string;
  entityType: string;
  entityId: string;
  category: string;
  originalName: string;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
  status: FileStatus;
  commitFailureCode: string | null;
  documentExpiresAt: string | null;
  expiryRemindedAt: Date | null;
  uploadedBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/** §7's `GET /documents` row — metadata only, never a path (BR-DOC-011). */
export interface FileMetadata {
  id: string;
  category: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
  documentExpiresAt: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

export interface UploadSlot {
  fileId: string;
  uploadUrl: string;
  uploadExpiresAt: Date;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

/** §12's usage aggregate, the one row shape `StorageUsagePort` returns. */
export interface CategoryUsage {
  category: string;
  fileCount: number;
  totalBytes: number;
}
