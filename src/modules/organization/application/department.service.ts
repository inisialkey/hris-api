import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { checkReparent, type GraphEdge } from '../domain/graph';
import { organizationErrors } from '../domain/organization.errors';
import {
  DEPARTMENT_REPOSITORY,
  type DepartmentRepositoryPort,
  type Page,
  type Paged,
} from '../domain/organization.ports';
import type { DepartmentRow } from '../domain/organization.types';
import { duplicate } from './field-errors';
import { requireCompanyInScope } from '../../../shared/data-scope';

/** BR-ORG-004. Six levels of hierarchy is a company, not a taxonomy. */
export const MAX_DEPARTMENT_DEPTH = 6;

export interface DepartmentListRow extends DepartmentRow {
  positionCount: number;
  depth: number;
}

export interface DepartmentTreeNode extends DepartmentRow {
  positionCount: number;
  children: DepartmentTreeNode[];
}

@Injectable()
export class DepartmentService {
  constructor(
    @Inject(DEPARTMENT_REPOSITORY) private readonly departments: DepartmentRepositoryPort,
  ) {}

  async list(filter: { companyId: string }, page: Page): Promise<Result<Paged<DepartmentListRow>>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const found = await this.departments.list(filter, page);
    const all = await this.departments.listAll(filter.companyId);
    const counts = await this.departments.positionCounts(found.rows.map((row) => row.id));
    const depths = depthMap(all);

    return ok({
      rows: found.rows.map((row) => ({
        ...row,
        positionCount: counts.get(row.id) ?? 0,
        depth: depths.get(row.id) ?? 1,
      })),
      total: found.total,
    });
  }

  /** `?tree=true` — the whole forest, unpaginated (§7): the depth cap bounds it. */
  async tree(companyId: string): Promise<Result<DepartmentTreeNode[]>> {
    const inScope = await requireCompanyInScope(companyId);
    if (!inScope.ok) return inScope;

    const all = await this.departments.listAll(companyId);
    const counts = await this.departments.positionCounts(all.map((row) => row.id));

    const nodes = new Map<string, DepartmentTreeNode>(
      all.map((row) => [row.id, { ...row, positionCount: counts.get(row.id) ?? 0, children: [] }]),
    );
    const roots: DepartmentTreeNode[] = [];
    for (const row of all) {
      const node = nodes.get(row.id);
      if (!node) continue;
      const parent = row.parentDepartmentId ? nodes.get(row.parentDepartmentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return ok(roots);
  }

  async create(input: Omit<DepartmentRow, 'id'>): Promise<Result<DepartmentRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    if (await this.departments.findByCode(input.companyId, input.code)) {
      return fail(duplicate('code'));
    }

    if (input.parentDepartmentId) {
      const parent = await this.departments.findById(input.parentDepartmentId);
      // Cross-company parents are 404 rather than a validation failure: the
      // parent is a row this caller may not see, and saying it exists is the
      // disclosure §2's scoping exists to prevent.
      if (!parent || parent.companyId !== input.companyId) return fail(sharedErrors.notFound());
    }

    const verdict = await this.checkGraph(input.companyId, 'new', input.parentDepartmentId);
    if (verdict !== 'ok') return fail(organizationErrors.cycleDetected());

    return ok(await this.departments.create(input));
  }

  /**
   * BR-ORG-004: re-parenting moves the whole subtree, so the depth check measures
   * the subtree and not the node. The move itself is one column — descendants are
   * never re-linked, which is what makes it one write and one audit row.
   */
  async update(
    id: string,
    patch: { name?: string; parentDepartmentId?: string | null },
  ): Promise<Result<DepartmentRow>> {
    const existing = await this.departments.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    if (patch.parentDepartmentId !== undefined) {
      if (patch.parentDepartmentId !== null) {
        const parent = await this.departments.findById(patch.parentDepartmentId);
        if (!parent || parent.companyId !== existing.companyId)
          return fail(sharedErrors.notFound());
      }
      const verdict = await this.checkGraph(existing.companyId, id, patch.parentDepartmentId);
      if (verdict !== 'ok') return fail(organizationErrors.cycleDetected());
    }

    const row = await this.departments.update(id, patch);
    return row ? ok(row) : fail(sharedErrors.notFound());
  }

  async archive(id: string): Promise<Result<void>> {
    const existing = await this.departments.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const blockers = await this.departments.archiveBlockers(id);
    if (blockers.length > 0) return fail(organizationErrors.inUse({ blockers }));

    await this.departments.archive(id);
    return ok(undefined);
  }

  private async checkGraph(companyId: string, nodeId: string, parentId: string | null | undefined) {
    const edges: GraphEdge[] = (await this.departments.listAll(companyId)).map((row) => ({
      id: row.id,
      parentId: row.parentDepartmentId,
    }));
    return checkReparent(edges, nodeId, parentId ?? null, MAX_DEPARTMENT_DEPTH);
  }
}

/** Depth for the flat grid's indentation — a root is 1 (§7's `depth` field). */
function depthMap(rows: readonly DepartmentRow[]): Map<string, number> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentDepartmentId]));
  const depths = new Map<string, number>();

  for (const row of rows) {
    let depth = 1;
    let cursor = row.parentDepartmentId;
    const seen = new Set<string>([row.id]);
    while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    depths.set(row.id, depth);
  }
  return depths;
}
