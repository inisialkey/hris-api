import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { cycleConflicts } from '../domain/overlap';
import { shiftErrors } from '../domain/shift.errors';
import {
  PATTERN_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_REPOSITORY,
  type PatternRepositoryPort,
  type ScheduleCachePort,
  type ShiftOutboxPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { Page, Paged, PatternWithDays } from '../domain/shift.types';
import { WriteGuards } from './write-guards';

export interface PatternDayInput {
  dayIndex: number;
  shiftId: string | null;
}

export interface CreatePatternInput {
  companyId: string;
  code: string;
  name: string;
  cycleLength: number;
  observesHolidays: boolean;
  days: PatternDayInput[];
}

export interface UpdatePatternInput {
  name?: string;
  observesHolidays?: boolean;
  cycleLength?: number;
  days?: PatternDayInput[];
}

export interface PatternListRow extends PatternWithDays {
  assignedEmployeeCount: number;
}

/**
 * UC-SHF-003 — build a pattern.
 *
 * The cycle is saved as a **replace-all** of `shift_pattern_days` in one
 * transaction, which is why the days carry no identity of their own (§4.1: hard
 * delete, replaced wholesale). Editing one entry and editing the whole strip are
 * the same operation, and a partial write would leave a cycle with a hole in it.
 */
@Injectable()
export class PatternService {
  constructor(
    @Inject(PATTERN_REPOSITORY) private readonly patterns: PatternRepositoryPort,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(SHIFT_OUTBOX) private readonly outbox: ShiftOutboxPort,
    private readonly guards: WriteGuards,
  ) {}

  async list(
    filter: { companyId: string; q?: string },
    page: Page,
  ): Promise<Result<Paged<PatternListRow>>> {
    const inScope = await requireCompanyInScope(filter.companyId);
    if (!inScope.ok) return inScope;

    const found = await this.patterns.list(filter, page);
    const counts = await this.patterns.assignedEmployeeCounts(
      found.rows.map((row) => row.id),
      this.guards.today(),
    );
    return ok({
      total: found.total,
      rows: found.rows.map((row) => ({ ...row, assignedEmployeeCount: counts.get(row.id) ?? 0 })),
    });
  }

  async find(id: string): Promise<Result<PatternWithDays>> {
    const pattern = await this.patterns.findById(id);
    if (!pattern) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(pattern.companyId);
    return inScope.ok ? ok(pattern) : inScope;
  }

  async create(input: CreatePatternInput): Promise<Result<PatternWithDays>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    const cycle = validateCycle(input.cycleLength, input.days);
    if (!cycle.ok) return cycle;

    if (await this.patterns.findByCode(input.companyId, input.code))
      return fail(duplicateOn('code'));

    const guarded = await this.guardCycle(input.companyId, input.cycleLength, input.days);
    if (!guarded.ok) return guarded;

    const created = await this.patterns.create(
      {
        companyId: input.companyId,
        code: input.code,
        name: input.name,
        cycleLength: input.cycleLength,
        observesHolidays: input.observesHolidays,
      },
      input.days,
    );
    await this.announce(created.companyId, created.id);
    return ok(created);
  }

  async update(id: string, patch: UpdatePatternInput): Promise<Result<PatternWithDays>> {
    const existing = await this.patterns.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const cycleLength = patch.cycleLength ?? existing.cycleLength;
    const days = patch.days ?? existing.days;

    // §7: changing `cycleLength` requires a full `days` array — a strip whose
    // length no longer matches its cycle is a pattern with unreachable entries.
    if (patch.cycleLength !== undefined && !patch.days) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'days',
            code: fieldCodes.required,
            messageKey: `errors.${fieldCodes.required}`,
            params: {},
          },
        ]),
      );
    }

    const cycle = validateCycle(cycleLength, days);
    if (!cycle.ok) return cycle;

    if (patch.days || patch.cycleLength !== undefined) {
      const guarded = await this.guardCycle(existing.companyId, cycleLength, days);
      if (!guarded.ok) return guarded;
    }

    const updated = await this.patterns.update(id, patch, patch.days);
    if (!updated) return fail(sharedErrors.notFound());
    await this.announce(updated.companyId, updated.id);
    return ok(updated);
  }

  /** BR-SHF-011 — a pattern is blocked by live or future roster assignments. */
  async archive(id: string): Promise<Result<{ id: string }>> {
    const existing = await this.patterns.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const inScope = await requireCompanyInScope(existing.companyId);
    if (!inScope.ok) return inScope;

    const blockers = await this.patterns.archiveBlockers(id, this.guards.today());
    if (blockers.length > 0) return fail(shiftErrors.inUse({ blockers }));

    await this.patterns.archive(id);
    await this.announce(existing.companyId, id);
    return ok({ id });
  }

  /** BR-SHF-006's static half: consecutive entries, wrap included. */
  private async guardCycle(
    companyId: string,
    cycleLength: number,
    days: readonly PatternDayInput[],
  ): Promise<Result<void>> {
    const referenced = days.map((day) => day.shiftId).filter((id): id is string => id !== null);
    const shifts = await this.shifts.findManyByIds([...new Set(referenced)]);

    for (const id of referenced) {
      const shift = shifts.get(id);
      // A shift outside the pattern's company is a 404 rather than a validation
      // entry: the caller was not entitled to learn it exists (§2).
      if (!shift || shift.companyId !== companyId) return fail(sharedErrors.notFound());
    }

    const first = cycleConflicts(days, cycleLength, shifts)[0];
    return first
      ? fail(
          shiftErrors.windowOverlap({
            dayIndex: first.dayIndex,
            conflictingShiftId: first.conflictingShiftId,
          }),
        )
      : ok(undefined);
  }

  private async announce(companyId: string, patternId: string): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    await this.cache.bustTenant(tenantId);
    await this.outbox.emit({
      name: 'shift.definition.changed',
      tenantId,
      aggregateId: patternId,
      payload: { companyId, patternIds: [patternId] },
    });
  }
}

/** §8: exactly `cycleLength` entries, each index `0..cycleLength-1` exactly once. */
export function validateCycle(cycleLength: number, days: readonly PatternDayInput[]): Result<void> {
  const seen = new Set(days.map((day) => day.dayIndex));
  const complete =
    days.length === cycleLength &&
    seen.size === cycleLength &&
    [...seen].every((index) => index >= 0 && index < cycleLength);

  return complete
    ? ok(undefined)
    : fail(
        sharedErrors.validationFailed([
          {
            field: 'days',
            code: fieldCodes.outOfRange,
            messageKey: `errors.${fieldCodes.outOfRange}`,
            params: { expected: cycleLength, received: days.length },
          },
        ]),
      );
}

function duplicateOn(name: string) {
  return sharedErrors.validationFailed([
    {
      field: name,
      code: fieldCodes.duplicate,
      messageKey: `errors.${fieldCodes.duplicate}`,
      params: { field: name },
    },
  ]);
}
