// The holiday facade — the only import path other modules may use (ADR-0001 §1).
//
// One port leaves and it answers one question: *is this date a working day for
// this scope, and if not, why* (holiday.md §4.2). Four modules ask it —
// attendance, leave, overtime and shift — and shift asks on behalf of the other
// three: attendance derivation reaches `dayType` **through** `ShiftQueryPort`,
// which applies suppression once when it resolves a scheduled day. One question,
// one answer, no second opinion (holiday.md §5, shift.md BR-SHF-004).
//
// The import definition does not cross this boundary. `holiday.calendar` is
// registered with the framework at module init (BR-IMP-001), so its consumer is
// import-export rather than another module.

export { HolidayModule } from './holiday.module';
export { HOLIDAY_QUERY_PORT, type HolidayQueryPort } from './domain/holiday.ports';
export type { DayType, HolidayKind, NonWorkingDay } from './domain/holiday.types';
