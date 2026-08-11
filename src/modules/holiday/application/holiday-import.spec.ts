import type { ParsedRow } from '../../import-export';
import { HolidayImportHandler, holidayImportDefinition } from './holiday-import';
import { FakeCache, FakeHolidays, FakeOutbox, fakeOrg, fakePeriods, inScope } from './test-support';

function row(values: Record<string, string>, rowNumber = 2): ParsedRow {
  return { rowNumber, values };
}

describe('holiday.calendar import — UC-HOL-004', () => {
  let holidays: FakeHolidays;
  let cache: FakeCache;
  let outbox: FakeOutbox;

  function build(locked = false) {
    return new HolidayImportHandler(
      holidays,
      fakeOrg(),
      fakePeriods(locked ? { date: '2026-05-01', periodId: 'per-1', label: 'May 2026' } : null),
      cache,
      outbox,
    );
  }

  beforeEach(() => {
    holidays = new FakeHolidays();
    cache = new FakeCache();
    outbox = new FakeOutbox();
  });

  describe('the definition — BR-HOL-007', () => {
    const definition = holidayImportDefinition({
      apply: () => Promise.resolve({ ok: true, value: undefined }),
    });

    it('upserts on (date, kind) and commits partially', () => {
      expect(definition).toMatchObject({
        key: 'holiday.calendar',
        requiredPermission: 'holiday.calendar.import',
        naturalKey: ['date', 'kind'],
        writeMode: 'upsert',
        commitMode: 'partial',
      });
    });

    it('carries no scope columns — the import writes tenant-wide rows only', () => {
      expect(definition.columns.map((column) => column.key)).toEqual(['date', 'name', 'kind']);
    });

    it('omits `custom` from the importable kinds', () => {
      const kind = definition.columns.find((column) => column.key === 'kind');
      expect(kind?.enumValues).toEqual(['national', 'cuti_bersama']);
    });
  });

  describe('apply', () => {
    it('creates a tenant-wide row and announces the date', async () => {
      const handler = build();
      const applied = await inScope([], () =>
        handler.apply(row({ date: '2026-05-01', name: 'National day A', kind: 'national' })),
      );

      expect(applied.ok).toBe(true);
      expect(holidays.rows).toHaveLength(1);
      expect(holidays.rows[0]).toMatchObject({ companyId: null, branchId: null, observed: true });
      expect(cache.busted).toEqual(['2026-05']);
      expect(outbox.events[0]?.payload).toMatchObject({ dates: ['2026-05-01'] });
    });

    it('updates the name of an existing (date, kind) rather than inserting a sibling', async () => {
      const handler = build();
      holidays.seed({ date: '2026-05-01', kind: 'national', name: 'old name' });

      await inScope([], () =>
        handler.apply(row({ date: '2026-05-01', name: 'National day A', kind: 'national' })),
      );

      expect(holidays.rows).toHaveLength(1);
      expect(holidays.rows[0]?.name).toBe('National day A');
    });

    it('leaves a company row alone — the natural key is tenant-wide', async () => {
      const handler = build();
      holidays.seed({ companyId: 'co-1', date: '2026-05-01', kind: 'national', name: 'theirs' });

      await inScope([], () =>
        handler.apply(row({ date: '2026-05-01', name: 'National day A', kind: 'national' })),
      );

      expect(holidays.rows).toHaveLength(2);
      expect(holidays.rows[0]?.name).toBe('theirs');
    });
  });

  describe('check — BR-HOL-008 at commit too', () => {
    it('refuses a row whose date sits in a locked period', async () => {
      const handler = build(true);
      const errors = await inScope([], () =>
        handler.check(row({ date: '2026-05-01', name: 'National day A', kind: 'national' })),
      );

      expect(errors).toEqual([
        {
          column: 'date',
          code: 'HOL_PERIOD_LOCKED',
          params: { date: '2026-05-01', periodId: 'per-1' },
        },
      ]);
    });

    it('passes an open date', async () => {
      const handler = build(true);
      const errors = await inScope([], () =>
        handler.check(row({ date: '2026-06-01', name: 'Cuti bersama A', kind: 'cuti_bersama' })),
      );
      expect(errors).toEqual([]);
    });
  });
});
