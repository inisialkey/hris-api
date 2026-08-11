import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext, requireTenantContext } from '../../../shared/context';
import { companyScope, requireCompanyInScope, requireTenantWide } from '../../../shared/data-scope';
import { PERIOD_LOCK_PORT, type PeriodLockPort } from '../../../shared/period-lock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { holidayErrors } from '../domain/holiday.errors';
import {
  HOLIDAY_CACHE,
  HOLIDAY_OUTBOX,
  HOLIDAY_REPOSITORY,
  type HolidayCachePort,
  type HolidayListFilter,
  type HolidayOutboxPort,
  type HolidayRepositoryPort,
  type NewHoliday,
  type SyncCursor,
} from '../domain/holiday.ports';
import type {
  HolidayKind,
  HolidayRow,
  HolidayScope,
  Page,
  Paged,
  ResolvedDay,
} from '../domain/holiday.types';
import { dayAfter, monthOf } from '../domain/months';
import { hasBroaderObserved, resolvedCalendar, type ResolvableRow } from '../domain/resolve';
import { HolidayQueryService } from './holiday-query.service';
import { SelfScopeService } from './self-scope.service';

export interface CreateHolidayInput {
  companyId: string | null;
  branchId: string | null;
  date: string;
  name: string;
  kind: HolidayKind;
  observed: boolean;
}

export interface UpdateHolidayInput {
  name?: string;
  date?: string;
  observed?: boolean;
}

/** §8's fat-finger guard: no 2091 holidays. */
const YEAR_WINDOW = 1;

/**
 * UC-HOL-002, UC-HOL-003 and the admin reads.
 *
 * Four gates run on every write, in this order, and the order is the point:
 * **scope** before anything (an out-of-scope company must not learn a date is
 * locked), then **shape** (§8), then **uniqueness and negation validity**
 * (BR-HOL-003, BR-HOL-004), then **the period lock** (BR-HOL-008) — the only one
 * that costs a cross-module call.
 */
@Injectable()
export class HolidayService {
  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepositoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(PERIOD_LOCK_PORT) private readonly periods: PeriodLockPort,
    @Inject(HOLIDAY_CACHE) private readonly cache: HolidayCachePort,
    @Inject(HOLIDAY_OUTBOX) private readonly outbox: HolidayOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly resolution: HolidayQueryService,
    private readonly self: SelfScopeService,
  ) {}

  /** §7's admin grid — raw rows, scope-filtered per assignment. */
  async list(
    filter: Omit<HolidayListFilter, 'companyIds'>,
    page: Page,
  ): Promise<Result<Paged<HolidayRow>>> {
    if (filter.companyId) {
      const inScope = await requireCompanyInScope(filter.companyId);
      if (!inScope.ok) return inScope;
    }
    return ok(await this.holidays.list({ ...filter, companyIds: await companyScope() }, page));
  }

  /**
   * §7's `/resolved` — BR-HOL-002 applied over a year.
   *
   * An admin resolves any in-scope pair; everyone else is forced to their own
   * employment scope, and the parameters they sent are **ignored rather than
   * refused**. That is the endpoint's own rule, and it is what lets one route
   * serve the admin calendar and the employee's holiday list. The route is
   * `@AuthenticatedOnly()`, so "admin" here means holding the read key —
   * resolved lazily, once, on a path an employee never pays for (ADR-0005).
   */
  async resolved(
    year: number,
    requested: HolidayScope,
  ): Promise<Result<{ scope: HolidayScope; days: ResolvedDay[] }>> {
    const held = await this.heldPermissions();
    const scope = held.has('holiday.calendar.read') ? requested : await this.self.resolve();

    if (held.has('holiday.calendar.read') && scope.companyId) {
      const inScope = await requireCompanyInScope(scope.companyId);
      if (!inScope.ok) return inScope;
    }

    const rows = await this.resolution.rowsBetween(`${year}-01-01`, `${year + 1}-01-01`);
    return ok({ scope, days: resolvedCalendar(rows, scope) });
  }

  /**
   * §7's `/sync` — the device's mirror, api-standards §8's shape: `(updated_at,
   * id)` keyset, tombstones included, **own employment scope only**. Sync is not
   * a privileged channel, so the same scope rule that narrows `/resolved` for an
   * employee narrows this for every caller, admin or not.
   */
  async sync(
    updatedSince: Date | null,
    cursor: SyncCursor | null,
    limit: number,
  ): Promise<Result<{ rows: HolidayRow[]; hasMore: boolean }>> {
    const scope = await this.self.resolve();
    // One row over the page size answers `hasMore` without a second count query.
    const rows = await this.holidays.changedSince(scope, updatedSince, cursor, limit + 1);
    return ok({ rows: rows.slice(0, limit), hasMore: rows.length > limit });
  }

  private async heldPermissions(): Promise<ReadonlySet<string>> {
    const authorization = await requireRequestContext().authorization?.resolve();
    return authorization?.permissions ?? new Set<string>();
  }

  async create(input: CreateHolidayInput): Promise<Result<HolidayRow>> {
    const scope = await this.authorizeScope(input.companyId, input.branchId);
    if (!scope.ok) return scope;

    const window = this.withinWriteWindow(input.date);
    if (!window.ok) return window;

    const rows = await this.rowsOn(input.date);
    const conflict = rows.find(
      (row) =>
        row.companyId === input.companyId &&
        row.branchId === input.branchId &&
        row.kind === input.kind,
    );
    if (conflict) return fail(duplicateOn('date'));

    const negation = this.checkNegation(rows, input);
    if (!negation.ok) return negation;

    const unlocked = await this.requireUnlocked(input.companyId, [input.date]);
    if (!unlocked.ok) return unlocked;

    const created = await this.holidays.create(input satisfies NewHoliday);
    await this.announce(created, [input.date]);
    return ok(created);
  }

  /**
   * UC-HOL-002's edit. `kind` and scope are identity — §7 says recreate instead —
   * so the only movable key is the date, and moving it must clear both ends:
   * the day being vacated and the day being entered (BR-HOL-008).
   */
  async update(id: string, patch: UpdateHolidayInput): Promise<Result<HolidayRow>> {
    const existing = await this.holidays.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const scope = await this.authorizeScope(existing.companyId, existing.branchId);
    if (!scope.ok) return scope;

    const date = patch.date ?? existing.date;
    const observed = patch.observed ?? existing.observed;

    if (patch.date && patch.date !== existing.date) {
      const window = this.withinWriteWindow(patch.date);
      if (!window.ok) return window;

      const conflict = (await this.rowsOn(patch.date)).find(
        (row) =>
          row.id !== id &&
          row.companyId === existing.companyId &&
          row.branchId === existing.branchId &&
          row.kind === existing.kind,
      );
      if (conflict) return fail(duplicateOn('date'));
    }

    if (!observed) {
      const negation = this.checkNegation(await this.rowsOn(date), {
        ...existing,
        date,
        observed,
      });
      if (!negation.ok) return negation;
    }

    const dates = [...new Set([existing.date, date])];
    const unlocked = await this.requireUnlocked(existing.companyId, dates);
    if (!unlocked.ok) return unlocked;

    const updated = await this.holidays.update(id, patch);
    if (!updated) return fail(sharedErrors.notFound());
    await this.announce(updated, dates);
    return ok(updated);
  }

  async remove(id: string): Promise<Result<{ id: string }>> {
    const existing = await this.holidays.findById(id);
    if (!existing) return fail(sharedErrors.notFound());

    const scope = await this.authorizeScope(existing.companyId, existing.branchId);
    if (!scope.ok) return scope;

    const unlocked = await this.requireUnlocked(existing.companyId, [existing.date]);
    if (!unlocked.ok) return unlocked;

    const deleted = await this.holidays.softDelete(id);
    if (!deleted) return fail(sharedErrors.notFound());
    await this.announce(deleted, [existing.date]);
    return ok({ id });
  }

  /**
   * §2's scope rule, both halves: a tenant-wide row needs a tenant-wide
   * assignment, and a scoped row needs its company — with an out-of-scope company
   * answering 404 rather than 403 (existence hiding, api-standards §11).
   *
   * The branch is checked against the company it was named beside rather than
   * merely for existence: a branch of another company would insert cleanly (the
   * FK is tenant-wide) and then address a scope chain resolution never walks.
   */
  private async authorizeScope(
    companyId: string | null,
    branchId: string | null,
  ): Promise<Result<void>> {
    if (companyId === null) return requireTenantWide('holiday.calendar.configure');

    const inScope = await requireCompanyInScope(companyId);
    if (!inScope.ok) return inScope;
    if (branchId === null) return ok(undefined);

    const owner = await this.org.branchCompanyId(branchId);
    return owner === companyId ? ok(undefined) : fail(sharedErrors.notFound());
  }

  /** §8 — the date sits within `year ± 1` of today at write. */
  private withinWriteWindow(date: string): Result<void> {
    const year = this.clock.now().getUTCFullYear();
    const written = Number(date.slice(0, 4));
    if (Math.abs(written - year) <= YEAR_WINDOW) return ok(undefined);
    return fail(
      sharedErrors.validationFailed([
        {
          field: 'date',
          code: fieldCodes.outOfRange,
          messageKey: `errors.${fieldCodes.outOfRange}`,
          params: { from: `${year - YEAR_WINDOW}-01-01`, to: `${year + YEAR_WINDOW}-12-31` },
        },
      ]),
    );
  }

  private checkNegation(
    rows: readonly ResolvableRow[],
    target: {
      companyId: string | null;
      branchId: string | null;
      date: string;
      kind: HolidayKind;
      observed: boolean;
    },
  ): Result<void> {
    if (target.observed) return ok(undefined);
    return hasBroaderObserved(rows, target)
      ? ok(undefined)
      : fail(holidayErrors.nothingToOverride({ date: target.date, kind: target.kind }));
  }

  /**
   * BR-HOL-008. A scoped row asks about its own company; a **tenant-wide** row
   * addresses every company at once, and `PeriodLockPort` answers about one — so
   * the enumeration happens here rather than in a port method that would have to
   * invent a tenant-wide notion of "locked".
   */
  private async requireUnlocked(companyId: string | null, dates: string[]): Promise<Result<void>> {
    const companies = companyId ? [companyId] : await this.org.companyIds();
    for (const company of companies) {
      const locked = await this.periods.firstLockedDate(company, dates);
      if (locked) {
        return fail(holidayErrors.periodLocked({ date: locked.date, periodId: locked.periodId }));
      }
    }
    return ok(undefined);
  }

  /** The live rows on one date, for the uniqueness and negation checks. */
  private async rowsOn(date: string): Promise<HolidayRow[]> {
    return this.holidays.inRange(date, dayAfter(date));
  }

  /**
   * §12 — one event per mutation carrying every affected date, and the cache bust
   * beside it. The bust is immediate because attendance and shift read through
   * this module per derived day; the event is what makes the bust survive a
   * process that is not the one holding the entry.
   */
  private async announce(row: HolidayRow, dates: string[]): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    await this.cache.bust(tenantId, [...new Set(dates.map(monthOf))]);
    await this.outbox.emit({
      name: 'holiday.calendar.changed',
      tenantId,
      aggregateId: row.id,
      payload: { companyId: row.companyId, branchId: row.branchId, dates },
    });
  }
}

function duplicateOn(field: string) {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.duplicate,
      messageKey: `errors.${fieldCodes.duplicate}`,
      params: { field },
    },
  ]);
}
