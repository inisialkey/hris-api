import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { ACTIVE_IMPORT_STATUSES, importJobs } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type {
  ImportJobFilter,
  ImportJobPatch,
  ImportJobRepositoryPort,
} from '../domain/import-export.ports';
import type { ImportJobRow, Page, Paged } from '../domain/import-export.types';

type ImportJobSelect = typeof importJobs.$inferSelect;

const TERMINAL = ['completed', 'partially_completed', 'failed', 'cancelled'] as const;

/**
 * **Not on `TenantScopedRepository`** — `import_jobs` has no audit-log §4.2
 * entry, so the base's constructor assertion would fail at module init, and it
 * should. A job row is machinery; what the trail wants is the writes the commit
 * made, and those are audited inside the modules whose `rowHandler` made them.
 * §12's `import-export.import.committed` is already on audit-log's consumed
 * list, which is where the headline is filed.
 *
 * No tenant predicate on reads: RLS supplies it (ADR-0002). Writes state the
 * tenant so the policy's `WITH CHECK` re-verifies it.
 */
@Injectable()
export class ImportJobRepository implements ImportJobRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  /**
   * BR-IMP-005, enforced by `uq_import_jobs_active` rather than by a read.
   *
   * §9 is explicit that *"the partial unique index decides at insert"*, and the
   * `ON CONFLICT … DO NOTHING` shape is what makes that true without a race: the
   * check and the write are one statement, so two admins uploading the same type
   * at the same moment cannot both pass a pre-check. The conflict target names
   * the index's own predicate, which is how PostgreSQL infers a *partial* unique
   * index — without it the statement matches no index and errors.
   */
  async insertIfNoneActive(type: string, fileId: string): Promise<ImportJobRow | null> {
    const actor = currentRequestContext()?.userId;
    const inserted = await this.db
      .insert(importJobs)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        type,
        fileId,
        status: 'uploaded',
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [importJobs.tenantId, importJobs.type],
        where: sql`status IN ('uploaded','validating','awaiting_confirmation','committing')`,
      })
      .returning();

    return inserted[0] ? toRow(inserted[0]) : null;
  }

  /** The loser's lookup: `IMP_ALREADY_RUNNING` carries the winner's id (§7). */
  async findActive(type: string): Promise<ImportJobRow | null> {
    const rows = await this.db
      .select()
      .from(importJobs)
      .where(
        and(eq(importJobs.type, type), inArray(importJobs.status, [...ACTIVE_IMPORT_STATUSES])),
      )
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findById(id: string): Promise<ImportJobRow | null> {
    const rows = await this.db.select().from(importJobs).where(eq(importJobs.id, id));
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(filter: ImportJobFilter, page: Page): Promise<Paged<ImportJobRow>> {
    const conditions = [];
    if (filter.type) conditions.push(eq(importJobs.type, filter.type));
    if (filter.status) conditions.push(eq(importJobs.status, filter.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(importJobs)
      .where(where)
      // `created_at` then `id`: api-standards §4 rule 1 — an offset page that
      // shuffles between requests is a grid that loses rows while it is read.
      .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
      .limit(page.limit)
      .offset(page.offset);

    const totals = await this.db.select({ value: count() }).from(importJobs).where(where);
    return { rows: rows.map(toRow), total: totals[0]?.value ?? 0 };
  }

  async update(id: string, patch: ImportJobPatch): Promise<ImportJobRow | null> {
    const updated = await this.db
      .update(importJobs)
      .set({ ...patch, updatedBy: currentRequestContext()?.userId })
      .where(eq(importJobs.id, id))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  /**
   * BR-IMP-011's sweep. The window runs from `confirmed_at`… which is null on an
   * `awaiting_confirmation` row, so it runs from `created_at`: the rule says
   * *"an import awaiting confirmation auto-cancels after 24 h"* and the only
   * stamp such a row carries is when it started. Validation is short-lived, so
   * the difference between "uploaded" and "dry-run finished" is minutes against
   * a day.
   */
  async staleAwaitingConfirmation(confirmedBefore: Date, limit: number): Promise<ImportJobRow[]> {
    const rows = await this.db
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.status, 'awaiting_confirmation'),
          lt(importJobs.createdAt, confirmedBefore),
        ),
      )
      .orderBy(asc(importJobs.createdAt))
      .limit(limit);
    return rows.map(toRow);
  }

  /**
   * The status predicate is the race, not a filter: a confirm arriving in the
   * same second must win or lose cleanly, and `false` here means it won.
   */
  async cancelIfAwaiting(id: string, at: Date): Promise<boolean> {
    const updated = await this.db
      .update(importJobs)
      .set({ status: 'cancelled', completedAt: at })
      .where(and(eq(importJobs.id, id), eq(importJobs.status, 'awaiting_confirmation')))
      .returning({ id: importJobs.id });
    return updated.length > 0;
  }

  async confirmIfAwaiting(
    id: string,
    by: string | undefined,
    at: Date,
  ): Promise<ImportJobRow | null> {
    const updated = await this.db
      .update(importJobs)
      .set({ status: 'committing', confirmedBy: by, confirmedAt: at, updatedBy: by })
      .where(and(eq(importJobs.id, id), eq(importJobs.status, 'awaiting_confirmation')))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  /**
   * §12's purge. Terminal rows only — an import still awaiting confirmation is
   * somebody's pending decision, and BR-IMP-011 is what ends those, not this.
   */
  async terminalCreatedBefore(cutoff: Date, limit: number): Promise<ImportJobRow[]> {
    const rows = await this.db
      .select()
      .from(importJobs)
      .where(and(inArray(importJobs.status, [...TERMINAL]), lt(importJobs.createdAt, cutoff)))
      .orderBy(asc(importJobs.createdAt))
      .limit(limit);
    return rows.map(toRow);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.delete(importJobs).where(eq(importJobs.id, id));
  }
}

function toRow(row: ImportJobSelect): ImportJobRow {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    fileId: row.fileId,
    errorReportFileId: row.errorReportFileId,
    templateVersion: row.templateVersion,
    totalRows: row.totalRows,
    validRows: row.validRows,
    errorRows: row.errorRows,
    appliedRows: row.appliedRows,
    lastCommittedBatch: row.lastCommittedBatch,
    failureCode: row.failureCode,
    // §7 calls it `requestedBy` on the wire; `created_by` is where it lives, and
    // BR-IMP-010 makes it the identity that may download an export output.
    requestedBy: row.createdBy,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
