import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { organizationErrors } from '../domain/organization.errors';
import { JOB_LEVEL_REPOSITORY, type JobLevelRepositoryPort } from '../domain/organization.ports';
import type { JobLevelRow } from '../domain/organization.types';
import { duplicate } from './field-errors';
import { requireTenantWide } from './scope';

export interface JobLevelListRow extends JobLevelRow {
  positionCount: number;
}

/**
 * Job levels are tenant-wide grade bands, so **every write needs a tenant-wide
 * assignment** (§2) — a company-scoped admin holding
 * `organization.structure.configure` still cannot add one, because the band
 * applies to companies they were not given.
 *
 * Reads are not gated the same way: the list is what a position form's picker
 * shows, and hiding it would make positions unconfigurable inside a scope that
 * is allowed to configure them.
 */
@Injectable()
export class JobLevelService {
  constructor(@Inject(JOB_LEVEL_REPOSITORY) private readonly jobLevels: JobLevelRepositoryPort) {}

  async list(): Promise<JobLevelListRow[]> {
    const rows = await this.jobLevels.list();
    const counts = await this.jobLevels.positionCounts(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, positionCount: counts.get(row.id) ?? 0 }));
  }

  async create(input: Omit<JobLevelRow, 'id'>): Promise<Result<JobLevelRow>> {
    const allowed = await requireTenantWide('organization.structure.configure');
    if (!allowed.ok) return allowed;

    if (await this.jobLevels.findByCode(input.code)) return fail(duplicate('code'));
    return ok(await this.jobLevels.create(input));
  }

  async update(
    id: string,
    patch: Partial<Omit<JobLevelRow, 'id' | 'code'>>,
  ): Promise<Result<JobLevelRow>> {
    const allowed = await requireTenantWide('organization.structure.configure');
    if (!allowed.ok) return allowed;

    const row = await this.jobLevels.update(id, patch);
    return row ? ok(row) : fail(sharedErrors.notFound());
  }

  async archive(id: string): Promise<Result<void>> {
    const allowed = await requireTenantWide('organization.structure.configure');
    if (!allowed.ok) return allowed;

    const existing = await this.jobLevels.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const blockers = await this.jobLevels.archiveBlockers(id);
    if (blockers.length > 0) return fail(organizationErrors.inUse({ blockers }));

    await this.jobLevels.archive(id);
    return ok(undefined);
  }
}
