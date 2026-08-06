import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { organizationErrors } from '../domain/organization.errors';
import {
  BRANCH_REPOSITORY,
  ORGANIZATION_OUTBOX,
  type BranchRepositoryPort,
  type OrganizationOutboxPort,
  type Page,
  type Paged,
} from '../domain/organization.ports';
import type { BranchRow } from '../domain/organization.types';
import { duplicate } from './field-errors';
import { requireCompanyInScope } from './scope';

/** BR-ORG-001. Indonesia has three, and §1 excludes international timezones from V1. */
export const INDONESIAN_TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;

export interface BranchListRow extends BranchRow {
  assignmentCount: number;
}

@Injectable()
export class BranchService {
  constructor(
    @Inject(BRANCH_REPOSITORY) private readonly branches: BranchRepositoryPort,
    @Inject(ORGANIZATION_OUTBOX) private readonly outbox: OrganizationOutboxPort,
  ) {}

  async list(
    filter: { companyId: string; q?: string },
    page: Page,
  ): Promise<Result<Paged<BranchListRow>>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const found = await this.branches.list(filter, page);
    const counts = await this.branches.assignmentCounts(found.rows.map((row) => row.id));

    return ok({
      rows: found.rows.map((row) => ({ ...row, assignmentCount: counts.get(row.id) ?? 0 })),
      total: found.total,
    });
  }

  async create(input: Omit<BranchRow, 'id'>): Promise<Result<BranchRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    if (await this.branches.findByCode(input.companyId, input.code)) {
      return fail(duplicate('code'));
    }

    const paired = pairedCoordinates(input);
    if (!paired.ok) return paired;

    return ok(await this.branches.create(input));
  }

  /**
   * BR-ORG-007: a timezone change affects **future interpretation only** — stored
   * punches are UTC and derived attendance is snapshotted. The event is the whole
   * mechanism for that promise, so it is emitted on the field changing and not on
   * every save: attendance recomputes future dates when it sees `timezone` in
   * `changedFields`, and a name edit that woke that job would be a recompute for
   * nothing.
   */
  async update(
    id: string,
    patch: Partial<Omit<BranchRow, 'id' | 'companyId' | 'code'>>,
  ): Promise<Result<BranchRow>> {
    const existing = await this.branches.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    // The pairing is checked against the **merged** row, not the patch: a PATCH
    // that sends one coordinate is editing a point, and whether it leaves a valid
    // one depends on what was already stored.
    const paired = pairedCoordinates({ ...existing, ...patch });
    if (!paired.ok) return paired;

    const row = await this.branches.update(id, patch);
    if (!row) return fail(sharedErrors.notFound());

    type EditableField = keyof Omit<BranchRow, 'id' | 'companyId' | 'code'>;
    const changedFields = (Object.keys(patch) as EditableField[]).filter(
      (field) => patch[field] !== undefined && patch[field] !== existing[field],
    );
    if (changedFields.length > 0) {
      await this.outbox.emit({
        name: 'organization.branch.updated',
        tenantId: requireTenantContext().tenantId,
        aggregateId: id,
        payload: { branchId: id, changedFields },
      });
    }

    return ok(row);
  }

  async archive(id: string): Promise<Result<void>> {
    const existing = await this.branches.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const blockers = await this.branches.archiveBlockers(id);
    if (blockers.length > 0) return fail(organizationErrors.inUse({ blockers }));

    await this.branches.archive(id);
    return ok(undefined);
  }
}

/**
 * §8: latitude and longitude are "both or neither". The database CHECK says the
 * same thing, but a constraint violation surfaces as `SYS_INTERNAL`, and §8 asks
 * for a field entry the form can point at — so the rule is enforced here and the
 * CHECK stays the backstop.
 */
function pairedCoordinates(row: {
  latitude?: string | null;
  longitude?: string | null;
}): Result<void> {
  const hasLatitude = row.latitude !== null && row.latitude !== undefined;
  const hasLongitude = row.longitude !== null && row.longitude !== undefined;
  if (hasLatitude === hasLongitude) return ok(undefined);

  return fail(
    sharedErrors.validationFailed([
      {
        field: hasLatitude ? 'longitude' : 'latitude',
        code: fieldCodes.required,
        messageKey: `errors.${fieldCodes.required}`,
      },
    ]),
  );
}
