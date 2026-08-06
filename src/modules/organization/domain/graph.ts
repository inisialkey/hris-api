/**
 * BR-ORG-004 — the two acyclic graphs, checked at write.
 *
 * `departments.parent_department_id` and `positions.reports_to_position_id` are
 * the same shape (a self-referencing nullable edge) with the same failure
 * (`ORG_CYCLE_DETECTED`), so they are one function. The only difference is the
 * depth cap: departments stop at 6, reporting lines have none — an org chart is
 * as deep as the company is, and capping it would refuse a legitimate structure
 * for no reason a user could act on.
 *
 * Re-parenting **moves the whole subtree** (BR-ORG-004), so the depth test is not
 * about the node being moved. A three-deep subtree hung under a node already at
 * depth 5 puts its leaves at 8, and checking only the node would pass it.
 */

export interface GraphEdge {
  id: string;
  parentId: string | null;
}

export type GraphVerdict = 'ok' | 'cycle' | 'too-deep';

/** Depth of a top-level node. A root sits at 1, so `maxDepth: 6` means six levels. */
const ROOT_DEPTH = 1;

export function checkReparent(
  edges: readonly GraphEdge[],
  nodeId: string,
  newParentId: string | null,
  maxDepth = Number.POSITIVE_INFINITY,
): GraphVerdict {
  if (newParentId === null) {
    return heightOf(edges, nodeId) <= maxDepth ? 'ok' : 'too-deep';
  }
  if (newParentId === nodeId) return 'cycle';

  const parentOf = new Map(edges.map((edge) => [edge.id, edge.parentId]));

  // Walking up from the *new* parent is the whole cycle test: if the node is
  // anywhere above its proposed parent, the edge would close a loop.
  let depth = ROOT_DEPTH;
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === nodeId) return 'cycle';
    // A loop already in the data would spin here forever. It cannot happen while
    // this function is the only writer, which is exactly why it must not assume it.
    if (seen.has(cursor)) return 'cycle';
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
    if (cursor !== null) depth += 1;
  }

  return depth + heightOf(edges, nodeId) <= maxDepth ? 'ok' : 'too-deep';
}

/** Levels occupied by the subtree rooted at `nodeId`, inclusive. A leaf is 1. */
function heightOf(edges: readonly GraphEdge[], nodeId: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.parentId === null) continue;
    childrenOf.set(edge.parentId, [...(childrenOf.get(edge.parentId) ?? []), edge.id]);
  }

  let height = 0;
  let level = [nodeId];
  const seen = new Set<string>();
  while (level.length > 0) {
    height += 1;
    const next: string[] = [];
    for (const node of level) {
      if (seen.has(node)) continue;
      seen.add(node);
      next.push(...(childrenOf.get(node) ?? []));
    }
    level = next;
  }
  return height;
}
