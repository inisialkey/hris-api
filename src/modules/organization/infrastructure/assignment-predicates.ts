import { and, gt, isNull, lte, or, type SQL } from 'drizzle-orm';

import { orgAssignments } from '../../../database/schema';

/**
 * `[effective_from, effective_to)` — database-conventions §5 rule 3, one
 * implementation reused (the rule says so in as many words).
 *
 * `deleted_at IS NULL` belongs in the same predicate rather than beside it: a
 * cancelled future move (UC-ORG-004) is not a placement, and every caller that
 * forgot the second half would silently count one.
 */
export function liveAssignmentAt(asOf: string): SQL {
  return and(
    isNull(orgAssignments.deletedAt),
    lte(orgAssignments.effectiveFrom, asOf),
    or(isNull(orgAssignments.effectiveTo), gt(orgAssignments.effectiveTo, asOf)),
  ) as SQL;
}
