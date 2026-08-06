import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import type { AssignmentRow, MoveRequest } from './organization.types';

export interface MovePlan {
  /** Predecessor to close at the new row's start — BR-ORG-008's supersede. */
  close: { id: string; effectiveTo: string } | null;
  insert: {
    positionId: string;
    branchId: string;
    kind: AssignmentRow['kind'];
    note: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  };
}

export interface CancelPlan {
  /** Soft-deleted, not dropped: §7 renders cancelled rows in history as `cancelled: true`. */
  softDelete: string;
  /** Predecessor to reopen, back to whatever the cancelled row was covering until. */
  reopen: { id: string; effectiveTo: string | null } | null;
}

/**
 * UC-ORG-003. A move is a supersede: the row covering the new date closes at it
 * and the successor takes over the rest of that row's interval, in one
 * transaction (BR-ORG-008, database-conventions §5.4).
 *
 * **Inheriting the predecessor's `effective_to` is what makes a backdated
 * `correction` land without colliding.** Correcting into a closed interval
 * inserts a row that ends where the next placement already began, so the timeline
 * stays gapless and the exclusion constraint has nothing to refuse. Naïvely
 * inserting an open-ended row instead would overlap every later placement.
 *
 * `rows` is the employee's whole live placement history, in any order. Company
 * agreement (BR-ORG-002) and the period lock (BR-ORG-008) are the caller's
 * checks — both need a database read this function deliberately does not have.
 */
export function planMove(
  rows: readonly AssignmentRow[],
  request: MoveRequest,
  joinDate: string,
): Result<MovePlan> {
  const from = request.effectiveFrom;

  if (from < joinDate) {
    // A placement before the join date describes an employment that had not
    // started. Nothing downstream — proration, cost attribution, rostering —
    // has an answer for it.
    return fail(outOfRange('effectiveFrom', { min: joinDate }));
  }

  const predecessor = rows.find((row) => covers(row, from));
  if (predecessor && predecessor.effectiveFrom >= from) {
    // Closing a row at its own start date would leave a zero-length interval:
    // a placement that never applied on any date, sitting in history looking
    // like one that did. Same-day corrections replace the *request*, not the row.
    return fail(outOfRange('effectiveFrom', { min: dayAfter(predecessor.effectiveFrom) }));
  }

  return ok({
    close: predecessor ? { id: predecessor.id, effectiveTo: from } : null,
    insert: {
      positionId: request.positionId,
      branchId: request.branchId,
      kind: request.kind,
      note: request.note ?? null,
      effectiveFrom: from,
      // The predecessor's old end, or the next placement that starts after this
      // date, or open-ended. All three are the same question — what is the next
      // thing on this employee's timeline.
      effectiveTo: predecessor ? predecessor.effectiveTo : (nextStartAfter(rows, from) ?? null),
    },
  });
}

/**
 * UC-ORG-004. Future rows only — a row already in effect is history, and history
 * is corrected by a new `correction` move rather than edited away (§7's `DELETE`
 * answers past and current with a field entry, not a module code).
 */
export function planCancel(
  rows: readonly AssignmentRow[],
  target: AssignmentRow,
  today: string,
): Result<CancelPlan> {
  if (target.effectiveFrom <= today) {
    return fail(
      sharedErrors.validationFailed([
        {
          field: 'id',
          code: fieldCodes.outOfRange,
          messageKey: `errors.${fieldCodes.outOfRange}`,
          params: { min: dayAfter(today) },
        },
      ]),
    );
  }

  // The row that was closed to make room for this one. It reopens to whatever
  // the cancelled row was covering until — usually `null`, and exactly `null` in
  // the ordinary case where the cancelled move was the last thing scheduled.
  const predecessor = rows.find(
    (row) => row.id !== target.id && row.effectiveTo === target.effectiveFrom,
  );

  return ok({
    softDelete: target.id,
    reopen: predecessor ? { id: predecessor.id, effectiveTo: target.effectiveTo } : null,
  });
}

/** `[effective_from, effective_to)` — database-conventions §5 rule 3, verbatim. */
export function covers(row: AssignmentRow, asOf: string): boolean {
  return row.effectiveFrom <= asOf && (row.effectiveTo === null || row.effectiveTo > asOf);
}

function nextStartAfter(rows: readonly AssignmentRow[], from: string): string | undefined {
  return rows
    .filter((row) => row.effectiveFrom > from)
    .map((row) => row.effectiveFrom)
    .sort()[0];
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

/**
 * Date arithmetic on the ISO string rather than through `Date`: these are
 * calendar dates in a branch timezone, and parsing one into a UTC instant to add
 * a day is how a boundary date moves by one in the wrong hemisphere.
 */
function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
