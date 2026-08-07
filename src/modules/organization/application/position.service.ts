import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { checkReparent, type GraphEdge } from '../domain/graph';
import { organizationErrors } from '../domain/organization.errors';
import {
  DEPARTMENT_REPOSITORY,
  EMPLOYEE_LOOKUP,
  JOB_LEVEL_REPOSITORY,
  POSITION_REPOSITORY,
  type DepartmentRepositoryPort,
  type EmployeeLookupPort,
  type JobLevelRepositoryPort,
  type Page,
  type Paged,
  type PositionFilter,
  type PositionRepositoryPort,
} from '../domain/organization.ports';
import type { ChartNode, PositionRow } from '../domain/organization.types';
import { duplicate } from './field-errors';
import { companyScope, requireCompanyInScope } from '../../../shared/data-scope';

export interface PositionListRow extends PositionRow {
  holderCount: number;
}

@Injectable()
export class PositionService {
  constructor(
    @Inject(POSITION_REPOSITORY) private readonly positions: PositionRepositoryPort,
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepositoryPort,
    @Inject(JOB_LEVEL_REPOSITORY) private readonly jobLevels: JobLevelRepositoryPort,
    // A-194: the caller's own employee row, until employee.md owns this read.
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(filter: PositionFilter, page: Page): Promise<Result<Paged<PositionListRow>>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const found = await this.positions.list(filter, page, this.today());
    const counts = await this.positions.holderCounts(
      found.rows.map((row) => row.id),
      this.today(),
    );

    return ok({
      rows: found.rows.map((row) => ({ ...row, holderCount: counts.get(row.id) ?? 0 })),
      total: found.total,
    });
  }

  async create(input: Omit<PositionRow, 'id'>): Promise<Result<PositionRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    if (await this.positions.findByCode(input.companyId, input.code)) {
      return fail(duplicate('code'));
    }

    const refs = await this.checkReferences(input.companyId, input);
    if (!refs.ok) return refs;

    if (input.reportsToPositionId) {
      const verdict = await this.checkGraph(input.companyId, 'new', input.reportsToPositionId);
      if (verdict !== 'ok') return fail(organizationErrors.cycleDetected());
    }

    return ok(await this.positions.create(input));
  }

  /**
   * A position moving to another department leaves every assignment untouched
   * (§9): position identity is stable, and a department move is not an employee
   * move. The chart and the reports simply read the new department.
   */
  async update(
    id: string,
    patch: {
      title?: string;
      departmentId?: string;
      jobLevelId?: string;
      reportsToPositionId?: string | null;
    },
  ): Promise<Result<PositionRow>> {
    const existing = await this.positions.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const refs = await this.checkReferences(existing.companyId, patch);
    if (!refs.ok) return refs;

    if (patch.reportsToPositionId !== undefined) {
      const verdict = await this.checkGraph(existing.companyId, id, patch.reportsToPositionId);
      if (verdict !== 'ok') return fail(organizationErrors.cycleDetected());
    }

    const row = await this.positions.update(id, patch);
    return row ? ok(row) : fail(sharedErrors.notFound());
  }

  async archive(id: string): Promise<Result<void>> {
    const existing = await this.positions.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const blockers = await this.positions.archiveBlockers(id);
    if (blockers.length > 0) return fail(organizationErrors.inUse({ blockers }));

    await this.positions.archive(id);
    return ok(undefined);
  }

  /**
   * UC-ORG-006. A non-admin caller is **forced** to their own company rather than
   * refused: the chart is the one authenticated-but-unkeyed surface in the module
   * (§7), and an employee looking at their own org chart is the ordinary case —
   * the one this endpoint mostly exists for.
   *
   * "Their own company" comes from their employment, not from a role assignment
   * they do not hold: an ordinary employee has no `user_roles` row, so
   * `companyScope` is empty for them and reading it would 404 the majority of
   * callers. An admin passes `companyId` (the scope bar) or falls back to the
   * single company they were given.
   */
  async chart(request: {
    companyId?: string;
    rootPositionId?: string;
    depth?: number;
  }): Promise<Result<ChartNode[]>> {
    const scope = await companyScope();
    const isAdmin = scope === null || scope.length > 0;

    const companyId = isAdmin
      ? (request.companyId ?? (scope !== null ? scope[0] : undefined))
      : await this.ownCompanyId();
    if (!companyId) return fail(sharedErrors.notFound());

    if (isAdmin) {
      const inScope = await requireCompanyInScope(companyId);
      if (!inScope.ok) return inScope;
    }

    const nodes = await this.positions.chart(companyId, this.today());
    return ok(slice(nodes, request.rootPositionId, request.depth));
  }

  private async ownCompanyId(): Promise<string | undefined> {
    const userId = currentRequestContext()?.userId;
    if (!userId) return undefined;
    return (await this.employees.findByUserId(userId))?.companyId;
  }

  /**
   * Cross-company references are **404, not 422** (§7): the referenced row is one
   * this caller cannot see, and a validation error naming it would confirm it
   * exists in a company they were not given.
   */
  private async checkReferences(
    companyId: string,
    refs: { departmentId?: string; jobLevelId?: string },
  ): Promise<Result<void>> {
    if (refs.departmentId !== undefined) {
      const department = await this.departments.findById(refs.departmentId);
      if (!department || department.companyId !== companyId) return fail(sharedErrors.notFound());
    }
    if (refs.jobLevelId !== undefined) {
      // Tenant-wide: a level belongs to no company, so there is nothing to match.
      const level = await this.jobLevels.findById(refs.jobLevelId);
      if (!level) return fail(sharedErrors.notFound());
    }
    return ok(undefined);
  }

  private async checkGraph(
    companyId: string,
    nodeId: string,
    reportsTo: string | null | undefined,
  ) {
    if (reportsTo === null || reportsTo === undefined) return 'ok';

    const all = await this.positions.listAll(companyId);
    // A reports-to outside the company is not a cycle, it is a row this caller
    // may not reference — and the edge set below would silently treat it as a
    // root and pass.
    if (!all.some((row) => row.id === reportsTo)) return 'cycle';

    const edges: GraphEdge[] = all.map((row) => ({
      id: row.id,
      parentId: row.reportsToPositionId,
    }));
    // No depth cap: an org chart is as deep as the company is (BR-ORG-004 caps
    // departments only).
    return checkReparent(edges, nodeId, reportsTo);
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

/** `?rootPositionId=` + `?depth=` — a slice of the one payload, not a second query. */
function slice(
  nodes: readonly ChartNode[],
  rootPositionId: string | undefined,
  depth: number | undefined,
): ChartNode[] {
  if (!rootPositionId) return [...nodes];

  const childrenOf = new Map<string, ChartNode[]>();
  for (const node of nodes) {
    if (!node.reportsToPositionId) continue;
    childrenOf.set(node.reportsToPositionId, [
      ...(childrenOf.get(node.reportsToPositionId) ?? []),
      node,
    ]);
  }

  const root = nodes.find((node) => node.positionId === rootPositionId);
  if (!root) return [];

  const collected: ChartNode[] = [];
  let level = [root];
  let remaining = depth ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  while (level.length > 0 && remaining > 0) {
    remaining -= 1;
    const next: ChartNode[] = [];
    for (const node of level) {
      if (seen.has(node.positionId)) continue;
      seen.add(node.positionId);
      collected.push(node);
      next.push(...(childrenOf.get(node.positionId) ?? []));
    }
    level = next;
  }
  return collected;
}
