/**
 * `PeriodLockPort` — **owned by `docs/06-modules/attendance.md` §4.2**, not by
 * whoever happens to be consuming it. "The module that owns the frozen data owns
 * the freezing" (implementation-roadmap.md, the one decision with no ADR).
 *
 * Attendance is spine order 4 and holiday, shift and organization are all built
 * before it, so all three specify a fake. The roadmap sanctions it once, here in
 * one sentence rather than three times in three modules: **the stub returns
 * "never locked" until attendance lands.** It lives in `shared/` for the same
 * reason — three consumers, one temporary answer, and moving it to attendance's
 * facade later is an import change in three files.
 *
 * `organization.md` §14 and `shift.md` §14 both carry the test scenario *"period
 * lock: locked month rejects, open passes (fake port both ways)"*, which is what
 * keeps the rejecting branch honest while the real implementation is missing:
 * the tests drive the port, not the stub.
 */

export const PERIOD_LOCK_PORT = Symbol('PERIOD_LOCK_PORT');

export interface PeriodLock {
  /** The locked period's id, for the `*_PERIOD_LOCKED` error's `details`. */
  periodId: string;
}

export interface PeriodLockPort {
  /**
   * The lock covering `date` for this employee, or `null` when the date is open.
   * `YYYY-MM-DD`, branch-local — a period is a calendar month in the branch's
   * timezone, never a UTC window.
   */
  lockAt(employeeId: string, date: string): Promise<PeriodLock | null>;
}

/** The sanctioned stub. Deleted the day attendance.md §4.2 ships the real one. */
export class NeverLockedPeriods implements PeriodLockPort {
  lockAt(): Promise<PeriodLock | null> {
    return Promise.resolve(null);
  }
}
