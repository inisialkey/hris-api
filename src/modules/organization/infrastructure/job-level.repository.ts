import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { jobLevels, positions } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { JobLevelRepositoryPort } from '../domain/organization.ports';
import type { ArchiveBlocker, JobLevelRow } from '../domain/organization.types';

/**
 * Job levels are **tenant-wide** — no `company_id` — which is what makes
 * configuring them require a tenant-wide assignment (§2) and what makes the list
 * unpaginated (§7: dozens of grade bands, a deliberate deviation with the authz
 * precedent).
 */
@Injectable()
export class JobLevelRepository extends TenantScopedRepository implements JobLevelRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, jobLevels, audit);
  }

  async list(): Promise<JobLevelRow[]> {
    const rows = await this.db
      .select()
      .from(jobLevels)
      .where(isNull(jobLevels.deletedAt))
      .orderBy(jobLevels.rank, jobLevels.name);
    return rows.map(toJobLevel);
  }

  async positionCounts(jobLevelIds: string[]): Promise<Map<string, number>> {
    const result = new Map(jobLevelIds.map((id) => [id, 0]));
    if (jobLevelIds.length === 0) return result;

    const rows = await this.db
      .select({ jobLevelId: positions.jobLevelId, total: count() })
      .from(positions)
      .where(and(inArray(positions.jobLevelId, jobLevelIds), isNull(positions.deletedAt)))
      .groupBy(positions.jobLevelId);

    for (const row of rows) result.set(row.jobLevelId, row.total);
    return result;
  }

  async findById(id: string): Promise<JobLevelRow | null> {
    const row = await this.findRowById(id);
    return row ? toJobLevel(row as JobLevelSelect) : null;
  }

  async findByCode(code: string): Promise<JobLevelRow | null> {
    const rows = await this.db
      .select()
      .from(jobLevels)
      .where(and(eq(jobLevels.code, code), isNull(jobLevels.deletedAt)));
    const row = rows[0];
    return row ? toJobLevel(row) : null;
  }

  async create(values: Omit<JobLevelRow, 'id'>): Promise<JobLevelRow> {
    return toJobLevel((await this.insertAudited({ ...values })) as JobLevelSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<JobLevelRow, 'id' | 'code'>>,
  ): Promise<JobLevelRow | null> {
    const row = await this.updateAudited(id, { ...patch });
    return row ? toJobLevel(row as JobLevelSelect) : null;
  }

  async archive(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  async archiveBlockers(id: string): Promise<ArchiveBlocker[]> {
    const rows = await this.db
      .select({ total: count() })
      .from(positions)
      .where(and(eq(positions.jobLevelId, id), isNull(positions.deletedAt)));

    const total = rows[0]?.total ?? 0;
    return total > 0 ? [{ type: 'position', count: total }] : [];
  }
}

type JobLevelSelect = typeof jobLevels.$inferSelect;

function toJobLevel(row: JobLevelSelect): JobLevelRow {
  return { id: row.id, code: row.code, name: row.name, rank: row.rank };
}
