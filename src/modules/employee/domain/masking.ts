import type { EmployeeRow, EncryptedSet } from './employee.types';

/**
 * BR-EMP-003 / §4.3's masking matrix.
 *
 * *"Masked always; reveal is the only full-value path."* This runs at the
 * presentation boundary of every read except the two reveal endpoints, so the
 * default a new endpoint inherits by calling the module's mappers is masked —
 * which is the direction that fails safe. A surface wanting full values has to
 * ask for them, and asking writes an audit row.
 *
 * The format is §4.3's, verbatim: all but the last four characters replaced,
 * and holder names keep their first word. The second rule is not decoration —
 * a bank holder shown as sixteen dots is unverifiable by the person it belongs
 * to, and the point of showing a masked value at all is that they can confirm
 * it is theirs without anyone reading it over their shoulder.
 */

const DOT = '•';

export function maskDigits(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 4) return DOT.repeat(value.length);
  return DOT.repeat(value.length - 4) + value.slice(-4);
}

export function maskHolderName(value: string | null): string | null {
  if (value === null) return null;
  const words = value.split(' ');
  return words.map((word, index) => (index === 0 ? word : DOT.repeat(word.length))).join(' ');
}

export type MaskedSet = EncryptedSet;

export function maskEncryptedSet(row: EncryptedSet): MaskedSet {
  return {
    // `nik` is non-null on the row and stays non-null masked — the column is
    // `NOT NULL` (BR-EMP-001), so a null here would mean a bug, not a gap.
    nik: maskDigits(row.nik) ?? '',
    npwp: maskDigits(row.npwp),
    bpjsKesehatanNumber: maskDigits(row.bpjsKesehatanNumber),
    bpjsKetenagakerjaanNumber: maskDigits(row.bpjsKetenagakerjaanNumber),
    bankAccountNumber: maskDigits(row.bankAccountNumber),
    bankAccountHolder: maskHolderName(row.bankAccountHolder),
  };
}

/** Detail and self-profile shape: the whole row with the encrypted set masked. */
export function maskEmployee(row: EmployeeRow): EmployeeRow {
  return { ...row, ...maskEncryptedSet(row) };
}
