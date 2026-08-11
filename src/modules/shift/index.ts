// The shift facade — the only import path other modules may use (ADR-0001 §1).
//
// One port leaves, and it answers one question: *is this employee working on this
// date, from when to when* (shift.md §4.2), with holiday suppression already
// applied. Four modules ask it — attendance per punch and per derivation day,
// overtime for its `endAt` baseline, leave for its working-day test, and payroll
// only indirectly, through attendance's derived day.
//
// Holiday suppression is applied **here** rather than by each consumer: attendance
// reaches `HolidayQueryPort.dayType` through this port, so one question gets one
// answer and no second opinion (holiday.md §5, BR-SHF-004).
//
// The import definition does not cross this boundary. `shift.roster` is registered
// with the framework at module init (BR-IMP-001), so its consumer is
// import-export rather than another module.

export { ShiftModule } from './shift.module';
export { SHIFT_QUERY_PORT, type ShiftQueryPort } from './domain/shift.ports';
export type { ScheduledDay, ScheduledShift } from './domain/shift.types';
