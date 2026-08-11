/**
 * BR-SHF-007's planner — pure, so the interesting cases are unit tests rather
 * than database fixtures.
 *
 * *"Re-assignment is a `supersede()` — close the current row at the new date,
 * insert the successor, one transaction"*, which is organization's BR-ORG-008
 * pattern and is planned the same way here: the caller never writes two rows
 * independently, and the gist exclusion is the backstop for the race no
 * application check can win.
 */

import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import type { AssignmentRow } from './shift.types';

export interface AssignRequest {
  companyId: string;
  employeeId: string | null;
  patternId: string;
  effectiveFrom: string;
  cycleAnchorDate: string;
  note: string | null;
}

export interface AssignPlan {
  close: { id: string; effectiveTo: string } | null;
  insert: Omit<AssignmentRow, 'id'>;
}

/** §8: the anchor may precede the range, but not by a decade. */
const MAX_ANCHOR_YEARS = 10;

export function planAssign(
  history: readonly AssignmentRow[],
  request: AssignRequest,
  joinDate: string | null,
): Result<AssignPlan> {
  if (joinDate && request.effectiveFrom < joinDate) {
    return fail(outOfRange('effectiveFrom', { min: joinDate }));
  }
  if (request.cycleAnchorDate > request.effectiveFrom) {
    return fail(outOfRange('cycleAnchorDate', { max: request.effectiveFrom }));
  }
  if (yearsBetween(request.cycleAnchorDate, request.effectiveFrom) > MAX_ANCHOR_YEARS) {
    return fail(outOfRange('cycleAnchorDate', { maxYears: MAX_ANCHOR_YEARS }));
  }

  const sorted = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const covering = sorted.find(
    (row) =>
      row.effectiveFrom <= request.effectiveFrom &&
      (row.effectiveTo === null || row.effectiveTo > request.effectiveFrom),
  );

  // §7: `effectiveFrom` must be **after** the current row's own start. Landing on
  // it would ask for a zero-length predecessor, which the half-open interval
  // cannot express and the exclusion constraint would refuse anyway.
  if (covering && covering.effectiveFrom === request.effectiveFrom) {
    return fail(outOfRange('effectiveFrom', { after: covering.effectiveFrom }));
  }

  // A row starting later than the new one would be left overlapping it, and the
  // planner does not silently rewrite rows the caller did not name.
  const laterRow = sorted.find((row) => row.effectiveFrom > request.effectiveFrom);
  const effectiveTo = laterRow ? laterRow.effectiveFrom : null;

  return ok({
    close: covering ? { id: covering.id, effectiveTo: request.effectiveFrom } : null,
    insert: {
      companyId: request.companyId,
      employeeId: request.employeeId,
      patternId: request.patternId,
      cycleAnchorDate: request.cycleAnchorDate,
      note: request.note,
      effectiveFrom: request.effectiveFrom,
      effectiveTo,
    },
  });
}

export interface CancelPlan {
  softDelete: string;
  reopen: { id: string; effectiveTo: string | null } | null;
}

/**
 * `DELETE /{id}` — **future rows only** (§7). Cancelling a row that has already
 * started would rewrite history somebody has been rostered against; the correction
 * for that is a new assignment, not a deletion.
 */
export function planCancel(
  history: readonly AssignmentRow[],
  target: AssignmentRow,
  today: string,
): Result<CancelPlan> {
  if (target.effectiveFrom <= today) {
    return fail(outOfRange('effectiveFrom', { after: today }));
  }

  const predecessor = history.find(
    (row) => row.id !== target.id && row.effectiveTo === target.effectiveFrom,
  );
  return ok({
    softDelete: target.id,
    reopen: predecessor ? { id: predecessor.id, effectiveTo: target.effectiveTo } : null,
  });
}

function yearsBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365.25 * 86_400_000);
}

function outOfRange(field: string, params: Record<string, unknown>) {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.outOfRange,
      messageKey: `errors.${fieldCodes.outOfRange}`,
      params,
    },
  ]);
}
