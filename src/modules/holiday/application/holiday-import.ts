import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { PERIOD_LOCK_PORT, type PeriodLockPort } from '../../../shared/period-lock.port';
import { ok, type Result } from '../../../shared/result';
import {
  registerImportDefinition,
  type ImportDefinition,
  type ImportRowHandler,
  type ParsedRow,
  type RowError,
} from '../../import-export';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { holidayRowCodes } from '../domain/holiday.errors';
import {
  HOLIDAY_CACHE,
  HOLIDAY_OUTBOX,
  HOLIDAY_REPOSITORY,
  type HolidayCachePort,
  type HolidayOutboxPort,
  type HolidayRepositoryPort,
} from '../domain/holiday.ports';
import type { HolidayKind } from '../domain/holiday.types';
import { dayAfter, monthOf } from '../domain/months';

export const HOLIDAY_IMPORT_KEY = 'holiday.calendar';

/**
 * UC-HOL-004, as an `ImportDefinition` (BR-IMP-001: definitions are owned by the
 * module whose rows they write, registered in code).
 *
 * Three properties come straight from BR-HOL-007 and each is expressed by a
 * field of the definition rather than by a check somebody has to remember:
 * **adds and updates only** is `writeMode: 'upsert'` against a natural key,
 * **tenant-wide rows only** is the absence of scope columns from the template,
 * and **`custom` is not importable** is the enum omitting it — a scoped or custom
 * row is a deliberate UI act, so it cannot arrive in a spreadsheet at all.
 */
@Injectable()
export class HolidayImportHandler implements ImportRowHandler {
  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepositoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(PERIOD_LOCK_PORT) private readonly periods: PeriodLockPort,
    @Inject(HOLIDAY_CACHE) private readonly cache: HolidayCachePort,
    @Inject(HOLIDAY_OUTBOX) private readonly outbox: HolidayOutboxPort,
  ) {}

  /**
   * BR-HOL-008 at commit too (UC-HOL-004) — and in the dry run, which is the
   * same code path (BR-IMP-002). A tenant-wide row addresses every company, so
   * every company's period must be open on that date; §9's *"one locked week
   * does not sink a monthly roster"* is what `partial` commit then delivers.
   */
  async check(row: ParsedRow): Promise<readonly RowError[]> {
    const date = String(row.values.date);
    for (const companyId of await this.org.companyIds()) {
      const locked = await this.periods.firstLockedDate(companyId, [date]);
      if (locked) {
        return [
          {
            column: 'date',
            code: holidayRowCodes.periodLocked,
            params: { date: locked.date, periodId: locked.periodId },
          },
        ];
      }
    }
    return [];
  }

  /**
   * The upsert. `name` is the only mutable column — the natural key is
   * `(date, kind)` and the scope is fixed — so a re-import is the government file
   * winning on names and nothing else (§9's *"import year collision with
   * hand-edited names"*).
   */
  async apply(row: ParsedRow): Promise<Result<void>> {
    const date = String(row.values.date);
    const kind = String(row.values.kind) as HolidayKind;
    const name = String(row.values.name);

    const existing = (await this.holidays.inRange(date, dayAfter(date))).find(
      (candidate) =>
        candidate.companyId === null && candidate.branchId === null && candidate.kind === kind,
    );

    const written = existing
      ? await this.holidays.update(existing.id, { name })
      : await this.holidays.create({
          companyId: null,
          branchId: null,
          date,
          name,
          kind,
          observed: true,
        });

    if (written) await this.announce(written.id, date);
    return ok(undefined);
  }

  /**
   * §12's event, per row rather than per commit batch.
   *
   * The framework commits in batches of two hundred and does not tell a handler
   * where a batch ends, so "one event per commit batch" is not expressible from
   * here. Per row is the honest alternative and is safe: consumers recompute by
   * date and the handler is idempotent, so a thousand-row calendar import costs a
   * thousand outbox rows and one recompute per date — which is what a
   * hand-entered calendar would have cost anyway.
   */
  private async announce(id: string, date: string): Promise<void> {
    const tenantId = requireTenantContext().tenantId;
    await this.cache.bust(tenantId, [monthOf(date)]);
    await this.outbox.emit({
      name: 'holiday.calendar.changed',
      tenantId,
      aggregateId: id,
      payload: { companyId: null, branchId: null, dates: [date] },
    });
  }
}

export function holidayImportDefinition(handler: ImportRowHandler): ImportDefinition {
  return {
    key: HOLIDAY_IMPORT_KEY,
    requiredPermission: 'holiday.calendar.import',
    templateVersion: 1,
    naturalKey: ['date', 'kind'],
    writeMode: 'upsert',
    commitMode: 'partial',
    columns: [
      {
        key: 'date',
        header: { id: 'Tanggal', en: 'Date' },
        type: 'date',
        required: true,
        example: '2026-01-01',
      },
      {
        key: 'name',
        header: { id: 'Nama', en: 'Name' },
        type: 'string',
        required: true,
        example: 'Tahun Baru',
      },
      {
        key: 'kind',
        header: { id: 'Jenis', en: 'Kind' },
        type: 'enum',
        // `custom` is deliberately absent — BR-HOL-007.
        enumValues: ['national', 'cuti_bersama'],
        required: true,
        example: 'national',
      },
    ],
    rowHandler: handler,
  };
}

/** Called once at module init, on `registerFileOwner`'s shape. */
export function registerHolidayImport(handler: ImportRowHandler): void {
  registerImportDefinition(holidayImportDefinition(handler));
}
