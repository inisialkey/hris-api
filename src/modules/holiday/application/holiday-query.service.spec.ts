import { HolidayQueryService } from './holiday-query.service';
import { COMPANY, FakeCache, FakeHolidays, inScope } from './test-support';

describe('HolidayQueryService — UC-HOL-001', () => {
  let holidays: FakeHolidays;
  let cache: FakeCache;
  let service: HolidayQueryService;

  beforeEach(() => {
    holidays = new FakeHolidays();
    cache = new FakeCache();
    service = new HolidayQueryService(holidays, cache);
  });

  it('answers a non-working day with the winning row', async () => {
    holidays.seed({ date: '2026-05-01' });
    const verdict = await inScope([], () => service.dayType(COMPANY, null, '2026-05-01'));
    expect(verdict).toEqual({
      working: false,
      holiday: { kind: 'national', name: 'National day A' },
    });
  });

  it('answers an unmarked date as working', async () => {
    const verdict = await inScope([], () => service.dayType(COMPANY, null, '2026-05-02'));
    expect(verdict).toEqual({ working: true });
  });

  it('reads the month once and serves the rest from the cache', async () => {
    holidays.seed({ date: '2026-05-01' });
    const reads: string[] = [];
    const counting = {
      ...holidays,
      inRange: (from: string, to: string) => {
        reads.push(from);
        return holidays.inRange(from, to);
      },
    } as typeof holidays;
    service = new HolidayQueryService(counting, cache);

    await inScope([], async () => {
      await service.dayType(COMPANY, null, '2026-05-01');
      await service.dayType(COMPANY, null, '2026-05-20');
      await service.dayType(COMPANY, null, '2026-06-01');
    });

    expect(reads).toEqual(['2026-05-01', '2026-06-01']);
  });

  it('caches the reducer’s input, not a scope’s answer — one entry serves every branch', async () => {
    holidays.seed({ companyId: COMPANY, branchId: 'br-1', date: '2026-05-01', kind: 'custom' });

    const [atBranch, elsewhere] = await inScope([], async () => [
      await service.dayType(COMPANY, 'br-1', '2026-05-01'),
      await service.dayType(COMPANY, 'br-2', '2026-05-01'),
    ]);

    expect(atBranch.working).toBe(false);
    expect(elsewhere.working).toBe(true);
    expect(cache.entries.size).toBe(1);
  });

  it('nonWorkingDays spans months and stays half-open', async () => {
    holidays.seed({ date: '2026-05-31' });
    holidays.seed({ date: '2026-06-01', kind: 'cuti_bersama', name: 'Cuti bersama A' });
    holidays.seed({ date: '2026-07-01', kind: 'custom', name: 'Company day' });

    const days = await inScope([], () =>
      service.nonWorkingDays(COMPANY, null, '2026-05-01', '2026-07-01'),
    );
    expect(days.map((day) => day.date)).toEqual(['2026-05-31', '2026-06-01']);
  });
});
