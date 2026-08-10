/**
 * BR-IMP-008, the whole rule: *"Typed coercion is deterministic: Excel serial
 * dates and ISO strings both normalize to `date`; decimals parse strictly per
 * column type (id-ID comma traps rejected, not guessed); strings trimmed;
 * fully-empty rows skipped; formula cells contribute cached values only."*
 *
 * Pure, and deliberately so — this is the one file in the module a test can
 * exhaust, and §14 asks for exactly that (*"Excel serial date = ISO string
 * result; '1.234,56' rejected with format error"*).
 *
 * **The word doing the work is "rejected, not guessed".** `1.234,56` is one
 * million two hundred thirty-four point five six to an Indonesian and a syntax
 * error to a parser that assumes the other convention; a coercion that picks one
 * is a silent ×1000 on somebody's salary. Every ambiguity below resolves the
 * same way: refuse and say what was expected.
 */

import { fieldCodes } from '../../../shared/shared.errors';
import type { ColumnValidator, ImportColumn } from './definitions';
import type { CellValue, RowError } from './import-export.types';

export type Coerced = { ok: true; value: CellValue } | { ok: false; error: RowError };

/**
 * An unknown cell as text, and `''` for anything that is not scalar.
 *
 * `String(x)` on an object yields `[object Object]`, which as a header name or a
 * version marker is a value that looks real and matches nothing. Everything
 * reading a raw workbook cell goes through here.
 */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Excel's day zero. 1899-12-30 rather than 1899-12-31 because the serial scheme
 * carries Lotus 1-2-3's belief that 1900 was a leap year — serial 60 is a day
 * that never existed, and every later serial is shifted by it. Subtracting a day
 * from the true epoch is how the world has agreed to absorb that, and getting it
 * wrong moves every imported date by one.
 */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/** BR-IMP-008's boolean vocabulary, both languages (A-200). */
const TRUTHY = new Set(['true', '1', 'yes', 'ya']);
const FALSY = new Set(['false', '0', 'no', 'tidak']);

export function coerce(column: ImportColumn, raw: unknown): Coerced {
  const normalized = normalizeRaw(raw);

  if (normalized === null) {
    return column.required
      ? { ok: false, error: { column: column.key, code: fieldCodes.required } }
      : { ok: true, value: null };
  }

  switch (column.type) {
    case 'string':
      return { ok: true, value: String(normalized).trim() };
    case 'date':
      return toDate(column, normalized);
    case 'decimal':
      return toDecimal(column, normalized);
    case 'integer':
      return toInteger(column, normalized);
    case 'boolean':
      return toBoolean(column, normalized);
    case 'enum':
      return toEnum(column, normalized);
  }
}

/**
 * Every cell shape exceljs can hand back, reduced to four.
 *
 * The formula cases are BR-IMP-008's last clause: a formula cell contributes its
 * **cached** value, because recomputing one would mean owning a spreadsheet
 * engine, and refusing one would reject the perfectly ordinary file where a
 * column is a lookup against a sheet the user built. A formula whose cached
 * value is an Excel error (`#N/A`) has no value at all, so it reads as absent
 * and the column's own `required` decides.
 */
function normalizeRaw(raw: unknown): string | number | boolean | Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return raw;

  if (typeof raw === 'object') {
    const cell = raw as Record<string, unknown>;
    if ('error' in cell) return null;
    if ('result' in cell) return normalizeRaw(cell.result);
    if ('richText' in cell && Array.isArray(cell.richText)) {
      const runs: unknown[] = cell.richText;
      const text = runs.map((run) => textOf((run as { text?: unknown }).text)).join('');
      return text.trim() === '' ? null : text;
    }
    if ('text' in cell) return normalizeRaw(cell.text);
    // A hyperlink with no text, a shared formula with no cached result: the cell
    // renders as nothing, so it is nothing.
    return null;
  }
  return null;
}

function toDate(column: ImportColumn, value: string | number | boolean | Date): Coerced {
  if (value instanceof Date) return { ok: true, value: isoDate(value) };
  if (typeof value === 'number') {
    // A serial is a count of days; the fractional part is a time of day this
    // column has no room for and truncating it is what "normalize to date" means.
    return { ok: true, value: isoDate(new Date(EXCEL_EPOCH_MS + Math.floor(value) * DAY_MS)) };
  }
  if (typeof value === 'string') {
    // `YYYY-MM-DD`, or the date half of a full ISO instant. `DD/MM/YYYY` is
    // **not** accepted and this is the same decision as the decimal comma: it is
    // indistinguishable from `MM/DD/YYYY`, and a guess turns 03/04 into either
    // March or April depending on who typed it.
    const head = value.trim().slice(0, 10);
    if (ISO_DATE.test(head) && isRealDate(head)) return { ok: true, value: head };
  }
  return { ok: false, error: format(column, 'YYYY-MM-DD') };
}

function toDecimal(column: ImportColumn, value: string | number | boolean | Date): Coerced {
  if (typeof value === 'number') {
    const text = String(value);
    // `1e+21` and larger stringify to exponent notation, which `numeric` will
    // not take and which nobody typed on purpose in a money column.
    return text.includes('e') || text.includes('E')
      ? { ok: false, error: format(column, '1234.56') }
      : { ok: true, value: text };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    // The named trap. A comma anywhere is refused rather than interpreted —
    // as a decimal mark it means one thing, as a thousands separator the
    // opposite, and the file does not say which.
    if (DECIMAL.test(text)) return { ok: true, value: text };
  }
  return { ok: false, error: format(column, '1234.56') };
}

function toInteger(column: ImportColumn, value: string | number | boolean | Date): Coerced {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value)
      ? { ok: true, value }
      : { ok: false, error: format(column, '123') };
  }
  if (typeof value === 'string' && INTEGER.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return { ok: true, value: parsed };
  }
  return { ok: false, error: format(column, '123') };
}

function toBoolean(column: ImportColumn, value: string | number | boolean | Date): Coerced {
  if (typeof value === 'boolean') return { ok: true, value };
  const text = String(value instanceof Date ? '' : value)
    .trim()
    .toLowerCase();
  if (TRUTHY.has(text)) return { ok: true, value: true };
  if (FALSY.has(text)) return { ok: true, value: false };
  return {
    ok: false,
    error: {
      column: column.key,
      code: fieldCodes.invalidEnum,
      params: { allowed: [...TRUTHY, ...FALSY] },
    },
  };
}

function toEnum(column: ImportColumn, value: string | number | boolean | Date): Coerced {
  const allowed = column.enumValues ?? [];
  const text = String(value instanceof Date ? isoDate(value) : value).trim();
  // Case-insensitive, canonical value returned. The template's hidden sheet
  // lists the exact spellings, but a person who typed `NATIONAL` into a column
  // whose sheet says `national` has made no mistake worth a rejected row.
  const match = allowed.find((option) => option.toLowerCase() === text.toLowerCase());
  return match !== undefined
    ? { ok: true, value: match }
    : {
        ok: false,
        error: { column: column.key, code: fieldCodes.invalidEnum, params: { allowed } },
      };
}

function format(column: ImportColumn, expected: string): RowError {
  return { column: column.key, code: fieldCodes.invalidFormat, params: { expected } };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `2026-02-30` matches the pattern and is not a day. */
function isRealDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === iso;
}

/**
 * BR-IMP-008's *"fully-empty rows skipped"* — a trailing row Excel keeps because
 * somebody once clicked in it, which must not become an error report entry
 * claiming eleven required fields are missing.
 */
export function isEmptyRow(values: Readonly<Record<string, unknown>>): boolean {
  return Object.values(values).every((value) => normalizeRaw(value) === null);
}

/** Runs a column's declared validators over an already-coerced, present value. */
export function runValidators(
  validators: readonly ColumnValidator[] | undefined,
  value: CellValue,
  row: { rowNumber: number; values: Readonly<Record<string, CellValue>> },
): RowError[] {
  if (!validators || value === null) return [];
  const errors: RowError[] = [];
  for (const validator of validators) {
    const error = validator(value, row);
    if (error) errors.push(error);
  }
  return errors;
}
