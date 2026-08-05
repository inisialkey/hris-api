/**
 * The carrier key for ADR-0007's field-entry array.
 *
 * ADR-0006 types `AppError.details` as `Record<string, unknown>`; ADR-0007 says
 * a `VAL_` failure's envelope `details` is *always* an array of field entries.
 * Both are right — the record is the in-process carrier, the array is the wire
 * shape — so an error factory puts the array under this key and `AppErrorFilter`
 * is the one place that unwraps it.
 *
 * Naming it here rather than inlining the string twice is the whole point: the
 * producer and the consumer cannot drift apart if there is only one spelling.
 */
export const FIELD_ENTRIES = '__fieldEntries';
