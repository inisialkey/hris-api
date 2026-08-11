import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import {
  ASSIGNMENT_REPOSITORY,
  BRANCH_REPOSITORY,
  COMPANY_REPOSITORY,
  DEPARTMENT_REPOSITORY,
  PLACEMENT_CACHE,
  POSITION_REPOSITORY,
  type AssignmentRepositoryPort,
  type AudienceRules,
  type BranchRepositoryPort,
  type CompanyRepositoryPort,
  type DepartmentRepositoryPort,
  type OrgQueryPort,
  type PlacementCachePort,
  type PositionRepositoryPort,
} from '../domain/organization.ports';
import type { Placement } from '../domain/organization.types';

/**
 * `OrgQueryPort` — the most-consumed port in the system (eleven module documents
 * reference it), so every method here is a hot path and none of them returns a
 * row another module could have joined to itself.
 */
@Injectable()
export class OrgQueryService implements OrgQueryPort {
  constructor(
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepositoryPort,
    @Inject(POSITION_REPOSITORY) private readonly positions: PositionRepositoryPort,
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepositoryPort,
    @Inject(BRANCH_REPOSITORY) private readonly branches: BranchRepositoryPort,
    @Inject(COMPANY_REPOSITORY) private readonly companies: CompanyRepositoryPort,
    @Inject(PLACEMENT_CACHE) private readonly cache: PlacementCachePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * UC-ORG-001. Cached only for **today**: the key holds one placement per
   * employee (§4.2), and an as-of read of some other date is a different answer
   * that would poison it. Historical reads are rare — payroll reads as-of a
   * period, once per run — so they simply skip the cache.
   *
   * `null` is normal only before the join date. Any other null is the anomaly
   * BR-ORG-002 exists to prevent, and employee.md's grid flags it "unplaced".
   */
  async placement(employeeId: string, asOf: string): Promise<Placement | null> {
    const tenantId = requireTenantContext().tenantId;
    const cacheable = asOf === this.clock.now().toISOString().slice(0, 10);

    if (cacheable) {
      const cached = await this.cache.read(tenantId, employeeId);
      if (cached) return cached;
    }

    const placement = await this.assignments.placement(employeeId, asOf);
    if (placement && cacheable) await this.cache.write(tenantId, employeeId, placement);
    return placement;
  }

  /** approval-engine §8 — live row, this tenant (RLS supplies the tenant). */
  async positionExists(positionId: string): Promise<boolean> {
    return (await this.positions.findById(positionId)) !== null;
  }

  /** holiday.md §8's scope check — one read, and `null` is both "gone" and "not yours". */
  async branchCompanyId(branchId: string): Promise<string | null> {
    return (await this.branches.findById(branchId))?.companyId ?? null;
  }

  /** holiday.md BR-HOL-008's enumeration — every live company, ids only. */
  async companyIds(): Promise<string[]> {
    return this.companies.listAllIds();
  }

  /** One query, keyed result — the grid form. Uncached: a page is a different shape. */
  async placements(employeeIds: string[], asOf: string): Promise<Map<string, Placement | null>> {
    const found = await this.assignments.placements(employeeIds, asOf);
    return new Map(employeeIds.map((id) => [id, found.get(id) ?? null]));
  }

  /**
   * UC-ORG-002, BR-ORG-003. Walk `levels` `reports_to` edges up from the
   * employee's position and return the holders of **exactly** that position.
   *
   * No skipping. A vacancy at level 1 with a holder at level 2 returns empty for
   * `directManagers(_, 1, _)` — the engine's vacancy ladder is what decides where
   * to go next (BR-APRV-006), and inventing a fallback here would take that
   * decision away from the module that owns it.
   */
  async directManagers(employeeId: string, levels: number, asOf: string): Promise<string[]> {
    const placement = await this.assignments.placement(employeeId, asOf);
    if (!placement) return [];

    const all = await this.positions.listAll(placement.companyId);
    const reportsTo = new Map(all.map((position) => [position.id, position.reportsToPositionId]));

    let cursor: string | null = placement.positionId;
    const seen = new Set<string>();
    for (let step = 0; step < levels; step += 1) {
      if (cursor === null || seen.has(cursor)) return [];
      seen.add(cursor);
      cursor = reportsTo.get(cursor) ?? null;
    }
    if (cursor === null) return []; // walked past the top

    return this.assignments.holderUserIds([cursor], asOf, employeeId);
  }

  async positionHolders(positionId: string, asOf: string): Promise<string[]> {
    return this.assignments.holderUserIds([positionId], asOf);
  }

  /**
   * BR-ORG-003's reporting line walked **downwards** — employee.md §13 has named
   * this a consumed capability ("team inverse") since 2026-08-02 and §4.2 never
   * wrote the method (A-195). UC-EMP-011's team list is its first caller.
   *
   * Two things differ from `directManagers`, both deliberate. It answers in
   * **employee** ids rather than user ids: the caller renders a roster, and a
   * direct report who cannot log in is still a direct report — the account
   * filter exists so the approval engine cannot assign a step to someone unable
   * to act on it, which is a different question. And it returns the holders of
   * **every** position reporting directly to any position the caller holds, so
   * a manager occupying two seats sees both teams as one list.
   */
  async directReports(employeeId: string, asOf: string): Promise<string[]> {
    const placement = await this.assignments.placement(employeeId, asOf);
    if (!placement) return [];

    const all = await this.positions.listAll(placement.companyId);
    const held = new Set(
      all.filter((position) => position.id === placement.positionId).map((p) => p.id),
    );
    const reporting = all
      .filter((position) => position.reportsToPositionId !== null)
      .filter((position) => held.has(position.reportsToPositionId as string))
      .map((position) => position.id);

    if (reporting.length === 0) return [];
    return this.assignments.holderEmployeeIds(reporting, asOf, employeeId);
  }

  /**
   * BR-ANN-002. The department subtree walk happens here rather than in the
   * caller because it is this module's tree and this module's depth cap — a flat
   * view cannot express ancestry, which is the whole reason the method lives on
   * this port (§13).
   */
  async audienceEmployeeIds(rules: AudienceRules, asOf: string): Promise<string[]> {
    const departmentIds = rules.departmentIds?.length
      ? await this.departments.descendantIds(rules.departmentIds)
      : undefined;

    return this.assignments.audienceEmployeeIds({ ...rules, departmentIds }, asOf);
  }
}
