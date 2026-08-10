/**
 * BR-IMP-009's *"per-row error **codes** + localized messages"*, and the honest
 * shape of that promise in a repository with no i18n bundle.
 *
 * ADR-0006 rule 4 puts user-facing text in the **client's** bundle: the server
 * sends `messageKey` and the client renders it. An error workbook has no client
 * — it is a server-generated document, which api-standards §3 says is the one
 * thing `Accept-Language` affects — so the text has to exist here or nowhere.
 *
 * The set is closed and small on purpose. These are the field-level codes *this
 * module raises* during coercion and cross-row checking; a module business code
 * arriving from a `rowHandler` (`PAY_SALARY_OVERLAP`, `AST_SERIAL_REQUIRED`)
 * gets its code written and no invented sentence, because its message lives in
 * that module's client bundle and writing a second one here is how two
 * translations of one rule start disagreeing. The workbook carries the code
 * column either way, and the code is what BR-IMP-009 makes the contract.
 */

import { fieldCodes } from '../../../shared/shared.errors';
import type { Locale, LocalizedText, RowError } from './import-export.types';

const MESSAGES: Readonly<Record<string, LocalizedText>> = {
  [fieldCodes.required]: { id: 'Wajib diisi', en: 'Required' },
  [fieldCodes.invalidFormat]: { id: 'Format tidak sesuai', en: 'Invalid format' },
  [fieldCodes.invalidEnum]: { id: 'Nilai tidak dikenal', en: 'Value not allowed' },
  [fieldCodes.outOfRange]: { id: 'Di luar rentang', en: 'Out of range' },
  [fieldCodes.duplicate]: { id: 'Duplikat di dalam berkas', en: 'Duplicate within the file' },
  [fieldCodes.tooLong]: { id: 'Terlalu panjang', en: 'Too long' },
  [fieldCodes.tooShort]: { id: 'Terlalu pendek', en: 'Too short' },
  [fieldCodes.dateRangeInvalid]: { id: 'Rentang tanggal tidak valid', en: 'Invalid date range' },
};

/**
 * The message for one row error, with the expectation appended where the code
 * carries one — *"Format tidak sesuai (1234.56)"* is a fixable error and
 * *"Format tidak sesuai"* is a support ticket.
 */
export function messageFor(error: RowError, locale: Locale): string {
  const base = MESSAGES[error.code]?.[locale] ?? error.code;
  const hint = hintOf(error);
  return hint ? `${base} (${hint})` : base;
}

function hintOf(error: RowError): string | null {
  const params = error.params;
  if (!params) return null;
  if (typeof params.expected === 'string') return params.expected;
  if (Array.isArray(params.allowed)) return params.allowed.join(', ');
  return null;
}
