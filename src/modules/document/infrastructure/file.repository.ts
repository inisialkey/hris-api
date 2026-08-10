import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, sum } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { files } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type {
  CommitPatch,
  FileRepositoryPort,
  NewFile,
  Page,
  Paged,
} from '../domain/document.ports';
import type { CategoryUsage, EntityRef, FileRow } from '../domain/document.types';

type FileSelect = typeof files.$inferSelect;

/**
 * **Not on `TenantScopedRepository`**, and the reason is the same shape
 * approval's instance repository states: `files` has no audit-log §4.2 entry, so
 * the base's constructor assertion would fail at module init. What audit wants
 * from this table it already gets from channel 2 — `document.file.committed` and
 * `document.file.deleted` are both on audit-log §12's consumed list.
 *
 * No tenant predicate on reads: RLS supplies it (ADR-0002). Writes state the
 * tenant so the policy's `WITH CHECK` re-verifies it.
 */
@Injectable()
export class FileRepository implements FileRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  async create(file: NewFile): Promise<FileRow> {
    const actor = currentRequestContext()?.userId;
    const inserted = await this.db
      .insert(files)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        ...file,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return toFile(inserted[0]!);
  }

  async findById(id: string): Promise<FileRow | null> {
    const rows = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), isNull(files.deletedAt)));
    return rows[0] ? toFile(rows[0]) : null;
  }

  /** §7: *"Committed, non-deleted rows only"* — a staged row is not a document. */
  async listByEntity(
    entityType: string,
    entityId: string,
    categories: readonly string[],
    page: Page,
  ): Promise<Paged<FileRow>> {
    if (categories.length === 0) return { rows: [], total: 0 };

    const where = and(
      eq(files.entityType, entityType),
      eq(files.entityId, entityId),
      inArray(files.category, [...categories]),
      eq(files.status, 'committed'),
      isNull(files.deletedAt),
    );

    const rows = await this.db
      .select()
      .from(files)
      .where(where)
      .orderBy(desc(files.createdAt))
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(files).where(where);

    return { rows: rows.map(toFile), total: totals[0]?.total ?? 0 };
  }

  /**
   * BR-DOC-006's idempotence lives above this line: the guard is `status =
   * 'staged'`, so a replayed confirm updates nothing and the use case returns
   * the row it already read.
   */
  async commit(id: string, patch: CommitPatch): Promise<FileRow | null> {
    const updated = await this.db
      .update(files)
      .set({
        ...patch,
        status: 'committed',
        commitFailureCode: null,
        updatedBy: currentRequestContext()?.userId,
      })
      .where(and(eq(files.id, id), eq(files.status, 'staged'), isNull(files.deletedAt)))
      .returning();
    return updated[0] ? toFile(updated[0]) : null;
  }

  /**
   * UC-IMP-001's re-parent, and the `status = 'committed'` predicate is the
   * guard rather than a filter: a staged row is a file nobody verified, and
   * moving one onto a job would make an unverified upload look like that job's
   * source workbook.
   */
  async reparent(id: string, ref: EntityRef): Promise<FileRow | null> {
    const updated = await this.db
      .update(files)
      .set({
        entityType: ref.entityType,
        entityId: ref.entityId,
        updatedBy: currentRequestContext()?.userId,
      })
      .where(and(eq(files.id, id), eq(files.status, 'committed'), isNull(files.deletedAt)))
      .returning();
    return updated[0] ? toFile(updated[0]) : null;
  }

  async recordCommitFailure(id: string, code: string): Promise<void> {
    await this.db
      .update(files)
      .set({ commitFailureCode: code })
      .where(and(eq(files.id, id), eq(files.status, 'staged')));
  }

  async softDelete(id: string, at: Date, by?: string): Promise<FileRow | null> {
    const updated = await this.db
      .update(files)
      .set({ deletedAt: at, deletedBy: by })
      .where(and(eq(files.id, id), isNull(files.deletedAt)))
      .returning();
    return updated[0] ? toFile(updated[0]) : null;
  }

  /** The row half of BR-DOC-009's object-then-row purge. */
  async hardDelete(id: string): Promise<void> {
    await this.db.delete(files).where(eq(files.id, id));
  }

  async dueForExpiryReminder(onOrBefore: string): Promise<FileRow[]> {
    const rows = await this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.status, 'committed'),
          isNotNull(files.documentExpiresAt),
          lte(files.documentExpiresAt, onOrBefore),
          isNull(files.expiryRemindedAt),
          isNull(files.deletedAt),
        ),
      )
      .orderBy(asc(files.documentExpiresAt));
    return rows.map(toFile);
  }

  async stampExpiryReminded(id: string, at: Date): Promise<void> {
    await this.db.update(files).set({ expiryRemindedAt: at }).where(eq(files.id, id));
  }

  async staleStaged(createdBefore: Date): Promise<FileRow[]> {
    const rows = await this.db
      .select()
      .from(files)
      .where(and(eq(files.status, 'staged'), lt(files.createdAt, createdBefore)));
    return rows.map(toFile);
  }

  async softDeletedOnOrBefore(deletedAt: Date, limit: number): Promise<FileRow[]> {
    const rows = await this.db
      .select()
      .from(files)
      .where(and(isNotNull(files.deletedAt), lte(files.deletedAt, deletedAt)))
      .orderBy(asc(files.deletedAt))
      .limit(limit);
    return rows.map(toFile);
  }

  async committedCreatedBefore(
    category: string,
    createdBefore: Date,
    limit: number,
  ): Promise<FileRow[]> {
    const rows = await this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.category, category),
          eq(files.status, 'committed'),
          lt(files.createdAt, createdBefore),
          isNull(files.deletedAt),
        ),
      )
      .orderBy(asc(files.createdAt))
      .limit(limit);
    return rows.map(toFile);
  }

  /**
   * §13's `StorageUsagePort`, and the whole of it: counts and bytes per category
   * for the tenant in context, aggregated in the database rather than by reading
   * rows a platform console has no business seeing.
   */
  async usageByCategory(): Promise<CategoryUsage[]> {
    const rows = await this.db
      .select({
        category: files.category,
        fileCount: count(),
        totalBytes: sum(files.sizeBytes),
      })
      .from(files)
      .where(isNull(files.deletedAt))
      .groupBy(files.category)
      .orderBy(asc(files.category));

    return rows.map((row) => ({
      category: row.category,
      fileCount: row.fileCount,
      // `sum()` is `numeric`, which arrives as a string (and as null on no rows).
      totalBytes: Number(row.totalBytes ?? 0),
    }));
  }
}

function toFile(row: FileSelect): FileRow {
  return {
    id: row.id,
    module: row.module,
    entityType: row.entityType,
    entityId: row.entityId,
    category: row.category,
    originalName: row.originalName,
    storagePath: row.storagePath,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    status: row.status,
    commitFailureCode: row.commitFailureCode,
    documentExpiresAt: row.documentExpiresAt,
    expiryRemindedAt: row.expiryRemindedAt,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}
