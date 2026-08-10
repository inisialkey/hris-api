import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { exportJobs } from '../../../database/schema';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import type { ExportJobPatch, ExportJobRepositoryPort } from '../domain/import-export.ports';
import type {
  ExportJobParams,
  ExportJobRow,
  ExportJobStatus,
  Page,
  Paged,
} from '../domain/import-export.types';

type ExportJobSelect = typeof exportJobs.$inferSelect;

const TERMINAL = ['completed', 'failed'] as const;

/**
 * **Not on `TenantScopedRepository`**, for `import_jobs`' reason exactly: no
 * audit-log §4.2 entry, and §12's `import-export.export.completed` is already on
 * audit's consumed list.
 *
 * BR-IMP-005 gives exports **no concurrency guard** — they are read-only, so two
 * of them racing produces two files and no contention worth a unique index.
 */
@Injectable()
export class ExportJobRepository implements ExportJobRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  async insert(type: string, params: ExportJobParams): Promise<ExportJobRow> {
    const actor = currentRequestContext()?.userId;
    const inserted = await this.db
      .insert(exportJobs)
      .values({
        id: uuidv7(),
        tenantId: requireTenantContext().tenantId,
        type,
        params,
        status: 'queued',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return toRow(inserted[0]!);
  }

  async findById(id: string): Promise<ExportJobRow | null> {
    const rows = await this.db.select().from(exportJobs).where(eq(exportJobs.id, id));
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(
    filter: { type?: string; status?: ExportJobStatus },
    page: Page,
  ): Promise<Paged<ExportJobRow>> {
    const conditions = [];
    if (filter.type) conditions.push(eq(exportJobs.type, filter.type));
    if (filter.status) conditions.push(eq(exportJobs.status, filter.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(exportJobs)
      .where(where)
      .orderBy(desc(exportJobs.createdAt), desc(exportJobs.id))
      .limit(page.limit)
      .offset(page.offset);

    const totals = await this.db.select({ value: count() }).from(exportJobs).where(where);
    return { rows: rows.map(toRow), total: totals[0]?.value ?? 0 };
  }

  async update(id: string, patch: ExportJobPatch): Promise<ExportJobRow | null> {
    const updated = await this.db
      .update(exportJobs)
      .set({ ...patch, updatedBy: currentRequestContext()?.userId })
      .where(eq(exportJobs.id, id))
      .returning();
    return updated[0] ? toRow(updated[0]) : null;
  }

  async terminalCreatedBefore(cutoff: Date, limit: number): Promise<ExportJobRow[]> {
    const rows = await this.db
      .select()
      .from(exportJobs)
      .where(and(inArray(exportJobs.status, [...TERMINAL]), lt(exportJobs.createdAt, cutoff)))
      .orderBy(asc(exportJobs.createdAt))
      .limit(limit);
    return rows.map(toRow);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.delete(exportJobs).where(eq(exportJobs.id, id));
  }
}

function toRow(row: ExportJobSelect): ExportJobRow {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    params: row.params as ExportJobParams,
    fileId: row.fileId,
    rowCount: row.rowCount,
    failureCode: row.failureCode,
    requestedBy: row.createdBy,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}
