/**
 * §8's `params` row — *"definition `ParamSpec` (types, ranges, required) →
 * `VAL_*` field entries"* — and §7's *"unknown/missing params are `VAL_` field
 * entries"*.
 *
 * Pure, because this is a validator and the only thing it needs is the spec and
 * the body. It also has a second consumer waiting: reports.md BR-RPT-013 says
 * its parameters are *"validated against the same `ParamSpec` machinery
 * import-export uses"*, so a report's params will run through this function
 * rather than a second copy of it.
 */

import type { ErrorDetailEntry } from '../../../shared/envelope';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { fail, ok, type Result } from '../../../shared/result';
import type { ParamSpec } from './definitions';
import type { ExportParams } from './import-export.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateParams(
  specs: readonly ParamSpec[],
  raw: Readonly<Record<string, unknown>>,
): Result<ExportParams> {
  const entries: ErrorDetailEntry[] = [];
  const params: Record<string, string | number | boolean> = {};

  for (const spec of specs) {
    const raw_ = raw[spec.key];
    // A whitespace-only string is absent too — api-standards §3's *"empty string
    // is never a valid value"*, applied after trimming rather than before, so
    // `"  "` is not a company id nobody can look up.
    const value = typeof raw_ === 'string' ? raw_.trim() : raw_;
    if (value === undefined || value === null || value === '') {
      if (spec.required) entries.push(entry(spec.key, fieldCodes.required));
      continue;
    }
    const coerced = coerceParam(spec, value);
    if (coerced === null) {
      entries.push(
        entry(
          spec.key,
          spec.type === 'enum' ? fieldCodes.invalidEnum : fieldCodes.invalidFormat,
          spec.type === 'enum' ? { allowed: spec.enumValues } : { expected: spec.type },
        ),
      );
      continue;
    }
    params[spec.key] = coerced;
  }

  // api-standards §3: *"unknown body fields are rejected … a typo'd optional
  // field must fail loudly, not silently no-op"*. A misspelled `branchid` would
  // otherwise produce a file scoped to the whole company and look correct.
  const declared = new Set(specs.map((spec) => spec.key));
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) entries.push(entry(key, fieldCodes.invalidEnum));
  }

  return entries.length > 0 ? fail(sharedErrors.validationFailed(entries)) : ok(params);
}

function coerceParam(spec: ParamSpec, value: unknown): string | number | boolean | null {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' ? value.trim() : null;
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? value : null;
    case 'date':
      // `YYYY-MM-DD`, the wire form ADR-0007 fixes for a date-only value. A
      // timestamp here would silently carry a timezone into a period filter.
      return typeof value === 'string' && ISO_DATE.test(value) && isRealDate(value) ? value : null;
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    case 'boolean':
      // api-standards §4 rule 5: literal `true`/`false`, nothing else.
      return typeof value === 'boolean' ? value : null;
    case 'enum':
      return typeof value === 'string' && (spec.enumValues ?? []).includes(value) ? value : null;
  }
}

function isRealDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

function entry(field: string, code: string, params?: Record<string, unknown>): ErrorDetailEntry {
  return { field, code, messageKey: `errors.${code}`, params };
}
