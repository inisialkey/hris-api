import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { settingsErrors } from './settings.errors';
import type { SettingDefinition, SettingLevel, SettingValueRow } from './setting.types';

export interface WriteRequest {
  level: SettingLevel;
  value: unknown;
  /** `YYYY-MM-DD`. Today for an immediate write, a later date to schedule. */
  effectiveFrom: string;
}

export interface WritePlan {
  action: 'set' | 'scheduled';
  /** Predecessor to close at the new row's start. */
  close: { id: string; effectiveTo: string } | null;
  /** Row superseded on the day it began — removed rather than closed to nothing. */
  drop: string | null;
  insert: { value: unknown; effectiveFrom: string; effectiveTo: string | null };
}

export interface CancelPlan {
  delete: string;
  /** Predecessor to reopen (`effective_to = NULL`). */
  reopen: string | null;
}

/**
 * UC-SET-002 and UC-SET-003 are the same arithmetic with different dates, so
 * they are one function: place a row on the date axis, and make the neighbours
 * agree. What separates them is only whether the date is today.
 *
 * `rows` is every row for this key at this exact scope, in any order. The caller
 * has already validated the value itself (`validateValue`) — this decides where
 * it goes and whether it may go there at all.
 */
export function planWrite(
  definition: SettingDefinition,
  rows: readonly SettingValueRow[],
  request: WriteRequest,
  today: string,
): Result<WritePlan> {
  if (!definition.allowedLevels.includes(request.level)) {
    return fail(settingsErrors.levelNotAllowed({ allowedLevels: definition.allowedLevels }));
  }

  const from = request.effectiveFrom;
  if (from < today) {
    // Backdating would rewrite what a payroll run already read as-of that date
    // (BR-SET-004). A correction is a supersede from today, never a rewrite.
    return fail(
      sharedErrors.validationFailed([
        {
          field: 'effectiveFrom',
          code: fieldCodes.outOfRange,
          messageKey: `errors.${fieldCodes.outOfRange}`,
          params: { min: today },
        },
      ]),
    );
  }

  const scheduling = from > today;
  if (scheduling && !definition.effectiveDated) return fail(settingsErrors.notEffectiveDated());

  // BR-SET-006: one scheduled row per key + scope. A second schedule replaces
  // intent, and replacing it silently is how two people disagree about what
  // happens next month — so it is refused, with the id to cancel.
  const existingSchedule = rows.find((row) => row.effectiveFrom > today);
  if (scheduling && existingSchedule) {
    return fail(settingsErrors.scheduleOverlap({ existingValueId: existingSchedule.id }));
  }

  const predecessor = rows.find((row) => covers(row, from));
  const sameDay = predecessor?.effectiveFrom === from;

  // The new row runs until whatever starts after it — usually nothing, but an
  // immediate write placed under an existing schedule stops at that schedule
  // rather than overlapping it into the exclusion constraint.
  const nextStart = rows
    .filter((row) => row.effectiveFrom > from)
    .map((row) => row.effectiveFrom)
    .sort()[0];

  return ok({
    action: scheduling ? 'scheduled' : 'set',
    close: predecessor && !sameDay ? { id: predecessor.id, effectiveTo: from } : null,
    drop: sameDay && predecessor ? predecessor.id : null,
    insert: { value: request.value, effectiveFrom: from, effectiveTo: nextStart ?? null },
  });
}

/**
 * UC-SET-004. The delete is hard — the row is gone, which is why the event
 * carries the dead value (§12): without it the cancellation leaves no fact
 * behind for audit to consume.
 */
export function planCancel(
  rows: readonly SettingValueRow[],
  target: SettingValueRow,
  today: string,
): Result<CancelPlan> {
  // BR-SET-005. A row starting today is already being read as-of by requests in
  // flight, which puts it on the history side of the line rather than the
  // scheduled side.
  if (target.effectiveFrom <= today) return fail(settingsErrors.historyImmutable());

  const predecessor = rows.find((row) => row.effectiveTo === target.effectiveFrom);
  return ok({ delete: target.id, reopen: predecessor?.id ?? null });
}

function covers(row: SettingValueRow, asOf: string): boolean {
  return row.effectiveFrom <= asOf && (row.effectiveTo === null || row.effectiveTo > asOf);
}
