/**
 * `PeriodLockPort` — **owned by `docs/06-modules/attendance.md` §4.2**, not by
 * whoever happens to be consuming it. "The module that owns the frozen data owns
 * the freezing" (implementation-roadmap.md, the one decision with no ADR).
 *
 * Attendance is the backbone module after shift, and holiday, shift and
 * organization are all built before it, so all three specify a fake. The roadmap
 * sanctions it once, here in one sentence rather than three times in three
 * modules: **the stub returns "never locked" until attendance lands.** It lives
 * in `shared/` for the same reason — three consumers, one temporary answer, and
 * moving it to attendance's facade later is an import change in three files.
 *
 * `organization.md` §14, `holiday.md` §14 and `shift.md` §14 all carry the test
 * scenario *"period lock: locked month rejects, open passes (fake port both
 * ways)"*, which is what keeps the rejecting branch honest while the real
 * implementation is missing: the tests drive the port, not the stub.
 *
 * **The signature is attendance.md §4.2's, verbatim** *(corrected 2026-08-11,
 * holiday module — it previously read `lockAt(employeeId, date)`, which no
 * document declares)*. A period is company-scoped and date-ranged
 * (BR-ATT-014); keying it by employee made organization's own caller look
 * natural and made every other consumer wrong, since a shift definition and a
 * holiday row are company facts that name no employee at all.
 */

export const PERIOD_LOCK_PORT = Symbol('PERIOD_LOCK_PORT');

export interface LockedDate {
  date: string;
  periodId: string;
  /** The period's human label, for the `*_PERIOD_LOCKED` error's `details`. */
  label: string;
}

export interface PeriodLockPort {
  /** A date no period row covers is open. `YYYY-MM-DD`, branch-local. */
  isLocked(companyId: string, date: string): Promise<boolean>;
  /** First locked date in a set — one query for range-affecting writes. */
  firstLockedDate(companyId: string, dates: string[]): Promise<LockedDate | null>;
}

/** The sanctioned stub. Deleted the day attendance.md §4.2 ships the real one. */
export class NeverLockedPeriods implements PeriodLockPort {
  isLocked(): Promise<boolean> {
    return Promise.resolve(false);
  }

  firstLockedDate(): Promise<LockedDate | null> {
    return Promise.resolve(null);
  }
}
