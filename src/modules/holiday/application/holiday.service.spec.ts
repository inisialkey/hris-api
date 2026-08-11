import type { OrgQueryPort } from '../../organization';
import { HolidayQueryService } from './holiday-query.service';
import { HolidayService } from './holiday.service';
import { SelfScopeService } from './self-scope.service';
import {
  BRANCH,
  COMPANY,
  FakeCache,
  FakeHolidays,
  FakeOutbox,
  TENANT,
  clock,
  fakeEmployeeScope,
  fakeOrg,
  fakePeriods,
  inScope,
} from './test-support';
import type { LockedDate, PeriodLockPort } from '../../../shared/period-lock.port';

const READ = 'holiday.calendar.read';
const CONFIGURE = 'holiday.calendar.configure';
const ADMIN = [READ, CONFIGURE];

describe('HolidayService — UC-HOL-002/003', () => {
  let holidays: FakeHolidays;
  let cache: FakeCache;
  let outbox: FakeOutbox;

  function build(options: { periods?: PeriodLockPort; org?: OrgQueryPort } = {}) {
    const org = options.org ?? fakeOrg();
    const resolution = new HolidayQueryService(holidays, cache);
    const self = new SelfScopeService(fakeEmployeeScope(), org, clock);
    return new HolidayService(
      holidays,
      org,
      options.periods ?? fakePeriods(),
      cache,
      outbox,
      clock,
      resolution,
      self,
    );
  }

  beforeEach(() => {
    holidays = new FakeHolidays();
    cache = new FakeCache();
    outbox = new FakeOutbox();
  });

  const tenantWide = {
    companyId: null,
    branchId: null,
    date: '2026-05-01',
    name: 'National day A',
    kind: 'national' as const,
    observed: true,
  };

  describe('create', () => {
    it('writes a tenant-wide row, busts its month and emits the change', async () => {
      const service = build();
      const created = await inScope(ADMIN, () => service.create(tenantWide));

      expect(created.ok).toBe(true);
      expect(cache.busted).toEqual(['2026-05']);
      expect(outbox.events).toHaveLength(1);
      expect(outbox.events[0]).toMatchObject({
        name: 'holiday.calendar.changed',
        tenantId: TENANT,
        payload: { companyId: null, branchId: null, dates: ['2026-05-01'] },
      });
    });

    it('§2: a company-scoped admin may not write a tenant-wide row', async () => {
      const service = build();
      const created = await inScope(ADMIN, () => service.create(tenantWide), [COMPANY]);

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('AUTHZ_PERMISSION_DENIED');
    });

    it('answers 404 for a company outside the caller’s scope, never 403', async () => {
      const service = build();
      const created = await inScope(
        ADMIN,
        () => service.create({ ...tenantWide, companyId: 'other-company' }),
        [COMPANY],
      );

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('SYS_NOT_FOUND');
    });

    it('refuses a branch that belongs to another company', async () => {
      const service = build();
      const created = await inScope(ADMIN, () =>
        service.create({ ...tenantWide, companyId: COMPANY, branchId: 'foreign-branch' }),
      );

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('SYS_NOT_FOUND');
    });

    it('§8: a date outside year ± 1 is out of range', async () => {
      const service = build();
      const created = await inScope(ADMIN, () =>
        service.create({ ...tenantWide, date: '2091-05-01' }),
      );

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('BR-HOL-003: a second row for the same scope, date and kind is a duplicate', async () => {
      const service = build();
      holidays.seed({ date: '2026-05-01', kind: 'national' });

      const created = await inScope(ADMIN, () => service.create(tenantWide));
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('BR-HOL-003: the same date at a narrower scope is a different row', async () => {
      const service = build();
      holidays.seed({ date: '2026-05-01', kind: 'national' });

      const created = await inScope(ADMIN, () =>
        service.create({ ...tenantWide, companyId: COMPANY, observed: false }),
      );
      expect(created.ok).toBe(true);
    });

    it('BR-HOL-004: negating nothing is refused', async () => {
      const service = build();
      const created = await inScope(ADMIN, () =>
        service.create({ ...tenantWide, companyId: COMPANY, observed: false }),
      );

      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.code).toBe('HOL_NOTHING_TO_OVERRIDE');
    });

    it('BR-HOL-004: a branch may negate a company day', async () => {
      const service = build();
      holidays.seed({ companyId: COMPANY, date: '2026-05-01', kind: 'national' });

      const created = await inScope(ADMIN, () =>
        service.create({
          ...tenantWide,
          companyId: COMPANY,
          branchId: BRANCH,
          observed: false,
        }),
      );
      expect(created.ok).toBe(true);
    });

    it('BR-HOL-008: a locked date refuses the write', async () => {
      const locked: LockedDate = { date: '2026-05-01', periodId: 'per-1', label: 'May 2026' };
      const service = build({ periods: fakePeriods(locked) });

      const created = await inScope(ADMIN, () => service.create(tenantWide));
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.error.code).toBe('HOL_PERIOD_LOCKED');
        expect(created.error.details).toMatchObject({ periodId: 'per-1' });
      }
      expect(outbox.events).toEqual([]);
    });

    it('BR-HOL-008: a tenant-wide row is checked against every company', async () => {
      const asked: string[] = [];
      const periods: PeriodLockPort = {
        isLocked: () => Promise.resolve(false),
        firstLockedDate: (companyId: string) => {
          asked.push(companyId);
          return Promise.resolve(null);
        },
      };
      const service = build({
        periods,
        org: fakeOrg({ companyIds: () => Promise.resolve(['co-a', 'co-b']) }),
      });

      await inScope(ADMIN, () => service.create(tenantWide));
      expect(asked).toEqual(['co-a', 'co-b']);
    });
  });

  describe('update', () => {
    it('clears both dates when the row moves and reports both in the event', async () => {
      const service = build();
      const row = holidays.seed({ date: '2026-05-01' });

      const updated = await inScope(ADMIN, () => service.update(row.id, { date: '2026-06-02' }));
      expect(updated.ok).toBe(true);
      expect(outbox.events[0]?.payload).toMatchObject({ dates: ['2026-05-01', '2026-06-02'] });
      expect(cache.busted).toEqual(['2026-05', '2026-06']);
    });

    it('refuses a move onto an occupied (scope, date, kind)', async () => {
      const service = build();
      const row = holidays.seed({ date: '2026-05-01' });
      holidays.seed({ date: '2026-06-02', kind: 'national' });

      const updated = await inScope(ADMIN, () => service.update(row.id, { date: '2026-06-02' }));
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('BR-HOL-004 applies when an existing row is flipped to a negation', async () => {
      const service = build();
      const row = holidays.seed({ companyId: COMPANY, date: '2026-05-01' });

      const updated = await inScope(ADMIN, () => service.update(row.id, { observed: false }));
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error.code).toBe('HOL_NOTHING_TO_OVERRIDE');
    });

    it('is 404 for an unknown row', async () => {
      const service = build();
      const updated = await inScope(ADMIN, () => service.update('missing', { name: 'x' }));
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error.code).toBe('SYS_NOT_FOUND');
    });
  });

  describe('remove', () => {
    it('soft deletes, busts and announces', async () => {
      const service = build();
      const row = holidays.seed({ date: '2026-05-01' });

      const removed = await inScope(ADMIN, () => service.remove(row.id));
      expect(removed.ok).toBe(true);
      expect(holidays.rows[0]?.deletedAt).not.toBeNull();
      expect(outbox.events).toHaveLength(1);
    });

    it('BR-HOL-008: a locked date refuses the delete', async () => {
      const service = build({
        periods: fakePeriods({ date: '2026-05-01', periodId: 'per-1', label: 'May 2026' }),
      });
      const row = holidays.seed({ date: '2026-05-01' });

      const removed = await inScope(ADMIN, () => service.remove(row.id));
      expect(removed.ok).toBe(false);
      expect(holidays.rows[0]?.deletedAt).toBeNull();
    });
  });

  describe('resolved — §7', () => {
    it('lets a reader resolve the scope it asked for', async () => {
      const service = build();
      holidays.seed({
        companyId: COMPANY,
        date: '2026-05-01',
        name: 'Company day',
        kind: 'custom',
      });

      const resolved = await inScope(ADMIN, () =>
        service.resolved(2026, { companyId: COMPANY, branchId: null }),
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.scope).toEqual({ companyId: COMPANY, branchId: null });
        expect(resolved.value.days).toHaveLength(1);
      }
    });

    it('forces a caller without the read key to their own scope, ignoring the parameters', async () => {
      const org = fakeOrg({
        placement: () => Promise.resolve({ branchId: BRANCH } as never),
      });
      const resolution = new HolidayQueryService(holidays, cache);
      const self = new SelfScopeService(
        fakeEmployeeScope({ employeeId: 'emp-1', companyId: COMPANY }),
        org,
        clock,
      );
      const service = new HolidayService(
        holidays,
        org,
        fakePeriods(),
        cache,
        outbox,
        clock,
        resolution,
        self,
      );

      const resolved = await inScope([], () =>
        service.resolved(2026, { companyId: 'someone-elses-company', branchId: null }),
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok)
        expect(resolved.value.scope).toEqual({ companyId: COMPANY, branchId: BRANCH });
    });
  });

  describe('sync — api-standards §8', () => {
    it('reports hasMore without returning the probe row', async () => {
      const service = build();
      for (let index = 0; index < 3; index += 1) holidays.seed({ date: `2026-05-0${index + 1}` });

      const page = await inScope([], () => service.sync(null, null, 2));
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.value.rows).toHaveLength(2);
        expect(page.value.hasMore).toBe(true);
      }
    });
  });
});
