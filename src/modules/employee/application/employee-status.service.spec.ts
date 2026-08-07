import type { NewStatusHistory, StatusHistoryRepositoryPort } from '../domain/employee.ports';
import type { StatusHistoryRow } from '../domain/employee.types';
import type { EffectuateService } from './effectuate.service';
import { EmployeeStatusService } from './employee-status.service';

/**
 * `EmployeeStatusPort` (§13) — leave.md's only writer into BR-EMP-005's
 * `active ↔ on_leave` half.
 */
describe('EmployeeStatusService', () => {
  const NOW = new Date('2026-08-06T02:00:00Z');

  let inserted: NewStatusHistory[];
  let cancelled: string[];
  let applied: StatusHistoryRow[];
  let sourceRows: StatusHistoryRow[];

  const row = (over: Partial<StatusHistoryRow>): StatusHistoryRow => ({
    id: 'h',
    employeeId: 'e-1',
    status: 'on_leave',
    source: 'leave',
    sourceId: 'lr-1',
    effectiveDate: '2026-08-10',
    reason: null,
    appliedAt: null,
    ...over,
  });

  beforeEach(() => {
    inserted = [];
    cancelled = [];
    applied = [];
    sourceRows = [];
  });

  function build() {
    const history = {
      insert: (values: NewStatusHistory) => {
        inserted.push(values);
        return Promise.resolve({ ...row({}), ...values, id: `h-${String(inserted.length)}` });
      },
      cancel: (id: string) => {
        cancelled.push(id);
        return Promise.resolve(true);
      },
      forSource: () => Promise.resolve(sourceRows),
    } as unknown as StatusHistoryRepositoryPort;

    const effectuate = {
      apply: (r: StatusHistoryRow) => {
        applied.push(r);
        return Promise.resolve(true);
      },
    } as unknown as EffectuateService;

    return new EmployeeStatusService(history, effectuate, { now: () => NOW });
  }

  describe('scheduleLeaveStatus', () => {
    it('writes both ends of the leave, with the return the day after the last day', async () => {
      await build().scheduleLeaveStatus('e-1', '2026-08-10', '2026-08-14', 'lr-1');

      expect(inserted).toEqual([
        {
          employeeId: 'e-1',
          status: 'on_leave',
          source: 'leave',
          sourceId: 'lr-1',
          effectiveDate: '2026-08-10',
        },
        {
          employeeId: 'e-1',
          status: 'active',
          source: 'leave',
          sourceId: 'lr-1',
          // `to` is the last day *of* leave; the employee is back the day after.
          effectiveDate: '2026-08-15',
        },
      ]);
    });

    it('schedules rather than applies — approving today for next month moves nothing today', async () => {
      await build().scheduleLeaveStatus('e-1', '2026-09-01', '2026-09-05', 'lr-2');
      expect(inserted.every((r) => r.appliedAt === undefined)).toBe(true);
      expect(applied).toEqual([]);
    });

    it('crosses a month boundary correctly', async () => {
      await build().scheduleLeaveStatus('e-1', '2026-08-28', '2026-08-31', 'lr-3');
      expect(inserted[1]?.effectiveDate).toBe('2026-09-01');
    });
  });

  describe('cancelLeaveStatus', () => {
    it('drops both rows and moves nothing when the leave never started', async () => {
      sourceRows = [
        row({ id: 'h-1', status: 'on_leave', appliedAt: null }),
        row({ id: 'h-2', status: 'active', effectiveDate: '2026-08-15', appliedAt: null }),
      ];

      await build().cancelLeaveStatus('lr-1');

      expect(cancelled).toEqual(['h-1', 'h-2']);
      expect(inserted).toEqual([]);
      expect(applied).toEqual([]);
    });

    it('brings the return forward to today when the leave is already under way', async () => {
      // History is not edited: the employee *was* on leave. The reversal is a
      // new row applied now, which is §13's "reverses an already-applied one".
      sourceRows = [
        row({ id: 'h-1', status: 'on_leave', appliedAt: NOW }),
        row({ id: 'h-2', status: 'active', effectiveDate: '2026-08-15', appliedAt: null }),
      ];

      await build().cancelLeaveStatus('lr-1');

      expect(cancelled).toEqual(['h-2']);
      expect(inserted).toEqual([
        {
          employeeId: 'e-1',
          status: 'active',
          source: 'leave',
          sourceId: 'lr-1',
          effectiveDate: '2026-08-06',
        },
      ]);
      expect(applied).toHaveLength(1);
    });

    it('adds no reversal when the employee already came back', async () => {
      sourceRows = [
        row({ id: 'h-1', status: 'on_leave', appliedAt: NOW }),
        row({ id: 'h-2', status: 'active', effectiveDate: '2026-08-05', appliedAt: NOW }),
      ];

      await build().cancelLeaveStatus('lr-1');

      expect(cancelled).toEqual([]);
      expect(inserted).toEqual([]);
    });

    it('reads applied_at rather than the calendar', async () => {
      // A due row the job has not reached yet is unapplied: the status never
      // moved, so reversing it would set a status that was never set.
      sourceRows = [
        row({ id: 'h-1', status: 'on_leave', effectiveDate: '2026-08-01', appliedAt: null }),
        row({ id: 'h-2', status: 'active', effectiveDate: '2026-08-15', appliedAt: null }),
      ];

      await build().cancelLeaveStatus('lr-1');

      expect(inserted).toEqual([]);
    });

    it('does nothing for a request that scheduled nothing', async () => {
      sourceRows = [];
      await build().cancelLeaveStatus('lr-unknown');
      expect(cancelled).toEqual([]);
      expect(inserted).toEqual([]);
    });
  });
});
