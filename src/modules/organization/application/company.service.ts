import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { organizationErrors } from '../domain/organization.errors';
import {
  COMPANY_REPOSITORY,
  type CompanyRepositoryPort,
  type Page,
  type Paged,
} from '../domain/organization.ports';
import type { CompanyRow } from '../domain/organization.types';
import { duplicate } from './field-errors';
import { companyScope, requireCompanyInScope, requireTenantWide } from './scope';

export interface CompanyListRow extends CompanyRow {
  branchCount: number;
  employeeCount: number;
}

/**
 * UC-ORG-005 for `companies` — the one structure entity that is **tenant-wide
 * to create and archive** (§2). A company-scoped admin edits the companies they
 * were given and cannot mint a sixth, because a new company belongs to no
 * assignment they hold.
 */
@Injectable()
export class CompanyService {
  constructor(@Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepositoryPort) {}

  async list(filter: { q?: string }, page: Page): Promise<Paged<CompanyListRow>> {
    const scope = await companyScope();
    const found = await this.companies.list({ q: filter.q, companyIds: scope }, page);
    const counts = await this.companies.counts(found.rows.map((row) => row.id));

    return {
      rows: found.rows.map((row) => ({
        ...row,
        ...(counts.get(row.id) ?? { branchCount: 0, employeeCount: 0 }),
      })),
      total: found.total,
    };
  }

  async create(input: Omit<CompanyRow, 'id' | 'updatedAt'>): Promise<Result<CompanyRow>> {
    const allowed = await requireTenantWide('organization.company.configure');
    if (!allowed.ok) return allowed;

    // Pre-checked rather than left to the partial unique index: §7 wants a
    // `VAL_DUPLICATE` entry naming the field, and a constraint name cannot say
    // which field it was. The index stays the real guard for the race.
    if (await this.companies.findByCode(input.code)) return fail(duplicate('code'));

    return ok(await this.companies.create(input));
  }

  async update(
    id: string,
    patch: Partial<Omit<CompanyRow, 'id' | 'code' | 'updatedAt'>>,
  ): Promise<Result<CompanyRow>> {
    const inScope = await requireCompanyInScope(id);
    if (!inScope.ok) return inScope;

    const row = await this.companies.update(id, patch);
    return row ? ok(row) : fail(sharedErrors.notFound());
  }

  /**
   * BR-ORG-006. The blockers are read **before** the archive and returned with
   * their counts: §6 renders them in the confirm dialog, so "something references
   * this" is not a usable answer. Dependents are removed by explicit acts first,
   * never cascaded (BR-AUTHZ-005's philosophy).
   */
  async archive(id: string): Promise<Result<void>> {
    const allowed = await requireTenantWide('organization.company.configure');
    if (!allowed.ok) return allowed;

    const existing = await this.companies.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const blockers = await this.companies.archiveBlockers(id);
    if (blockers.length > 0) return fail(organizationErrors.inUse({ blockers }));

    await this.companies.archive(id);
    return ok(undefined);
  }
}
