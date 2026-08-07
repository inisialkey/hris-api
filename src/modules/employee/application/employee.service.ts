import { Inject, Injectable } from '@nestjs/common';

import { blindIndex } from '../../../shared/crypto/encrypted-text';
import { TenantKeyService } from '../../../shared/crypto/tenant-key.service';
import { companyScope, requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { ORG_QUERY_PORT, type OrgQueryPort, type Placement } from '../../organization';
import { employeeErrors } from '../domain/employee.errors';
import {
  CONTRACT_REPOSITORY,
  type ContractRepositoryPort,
  EMPLOYEE_REPOSITORY,
  type EmployeeRepositoryPort,
  FAMILY_REPOSITORY,
  type FamilyRepositoryPort,
  type Page,
  type Paged,
  STATUS_HISTORY_REPOSITORY,
  type StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type {
  ContractRow,
  EmployeeListRow,
  EmployeeRow,
  EmployeeStatus,
  EmployeeUpdateInput,
  FamilyMemberRow,
  StatusHistoryRow,
} from '../domain/employee.types';
import { isTerminal } from '../domain/status-machine';
import { duplicate, mapConstraintViolation } from './field-errors';

export interface EmployeeListEntry extends EmployeeListRow {
  placement: Placement | null;
  hasUser: boolean;
  contractEndDate: string | null;
}

export interface EmployeeDetail {
  employee: EmployeeRow;
  placement: Placement | null;
  currentContract: ContractRow | null;
  familyMembers: FamilyMemberRow[];
  statusHistory: StatusHistoryRow[];
}

/**
 * §7's `/employees` surface. Masking is **not** applied here — the presentation
 * mappers own it, and the split is deliberate: a service returning plaintext is
 * what lets the reveal endpoint reuse this exact read instead of growing a
 * second one that would eventually disagree about which fields exist.
 */
@Injectable()
export class EmployeeService {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepositoryPort,
    @Inject(FAMILY_REPOSITORY) private readonly family: FamilyRepositoryPort,
    @Inject(STATUS_HISTORY_REPOSITORY) private readonly history: StatusHistoryRepositoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    private readonly keys: TenantKeyService,
  ) {}

  async list(
    filter: { companyId?: string; status?: EmployeeStatus; employmentType?: string; q?: string },
    page: Page,
    asOf: string,
  ): Promise<Paged<EmployeeListEntry>> {
    const scope = await companyScope();
    const found = await this.employees.list({ ...filter, companyIds: scope }, page);

    // Placement is batch-resolved through the port, one query for the page —
    // never a call per row (coding-standards-nestjs §5, N+1 discipline).
    const placements = await this.org.placements(
      found.rows.map((row) => row.id),
      asOf,
    );

    const contracts = await this.contracts.currentAtBatch(
      found.rows.map((row) => row.id),
      asOf,
    );

    return {
      rows: found.rows.map((row) => ({
        ...row,
        placement: placements.get(row.id) ?? null,
        hasUser: row.userId !== null,
        contractEndDate: contracts.get(row.id)?.endDate ?? null,
      })),
      total: found.total,
    };
  }

  async detail(id: string, asOf: string): Promise<Result<EmployeeDetail>> {
    const employee = await this.employees.findById(id);
    if (!employee) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(employee.companyId);
    if (!inScope.ok) return inScope;

    const placement = await this.org.placement(id, asOf);
    const currentContract = await this.contracts.currentAt(id, asOf);
    const familyMembers = await this.family.listFor(id);
    const statusHistory = await this.history.listFor(id);

    return ok({ employee, placement, currentContract, familyMembers, statusHistory });
  }

  /**
   * UC-EMP-002 — the trusted-admin path. No approval chain: `employee.master.update`
   * *is* the authority, and channel-1 audit records the diff with `[encrypted]`
   * markers for the ADR-0016 set (BR-EMP-011).
   */
  async update(id: string, patch: EmployeeUpdateInput): Promise<Result<EmployeeRow>> {
    const existing = await this.employees.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const clash = await this.checkIdentifierEdit(id, patch);
    if (clash) return fail(clash);

    try {
      const row = await this.employees.update(id, patch);
      return row ? ok(row) : fail(sharedErrors.notFound());
    } catch (error) {
      const mapped = mapConstraintViolation(error);
      if (mapped) return fail(mapped);
      throw error;
    }
  }

  /**
   * BR-EMP-013 — soft delete only for terminal rows. An active employee is
   * terminated first, which is what makes the exit effects run: deleting one
   * outright would leave a live org assignment and a live login behind.
   */
  async archive(id: string): Promise<Result<void>> {
    const existing = await this.employees.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    if (!isTerminal(existing.status)) {
      return fail(employeeErrors.stillActive({ currentStatus: existing.status }));
    }

    return (await this.employees.softDelete(id)) ? ok(undefined) : fail(sharedErrors.notFound());
  }

  /** The edit half of BR-EMP-001, self-excluded so re-saving an unchanged NIK passes. */
  private async checkIdentifierEdit(id: string, patch: EmployeeUpdateInput) {
    if (patch.nik === undefined && patch.npwp === undefined) return null;
    const indexKey = await this.keys.indexKey();

    if (patch.nik !== undefined) {
      const clash = await this.employees.findLiveByNikBidx(blindIndex(indexKey, patch.nik), id);
      if (clash) return duplicate('nik');
    }
    if (patch.npwp) {
      const clash = await this.employees.findLiveByNpwpBidx(blindIndex(indexKey, patch.npwp), id);
      if (clash) return duplicate('npwp');
    }
    return null;
  }
}
