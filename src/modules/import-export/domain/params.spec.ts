import { FIELD_ENTRIES } from '../../../shared/validation-details';
import type { ErrorDetailEntry } from '../../../shared/envelope';
import type { ParamSpec } from './definitions';
import { validateParams } from './params';

const SPECS: ParamSpec[] = [
  { key: 'companyId', type: 'uuid', required: true },
  { key: 'from', type: 'date', required: true },
  { key: 'to', type: 'date', required: true },
  { key: 'branchId', type: 'uuid', required: false },
  { key: 'scope', type: 'enum', required: false, enumValues: ['all', 'unpaid'] },
  { key: 'limit', type: 'integer', required: false },
  { key: 'outstandingOnly', type: 'boolean', required: false },
];

const COMPANY = '018f2f4a-6d1e-7c00-9a2b-3c4d5e6f7a8b';

function entriesOf(result: ReturnType<typeof validateParams>): ErrorDetailEntry[] {
  if (result.ok) throw new Error('expected a validation failure');
  return (result.error.details?.[FIELD_ENTRIES] ?? []) as ErrorDetailEntry[];
}

describe('§8 export params', () => {
  it('accepts a body that satisfies every spec', () => {
    const result = validateParams(SPECS, {
      companyId: COMPANY,
      from: '2026-01-01',
      to: '2026-01-31',
      scope: 'unpaid',
    });
    expect(result).toEqual({
      ok: true,
      value: { companyId: COMPANY, from: '2026-01-01', to: '2026-01-31', scope: 'unpaid' },
    });
  });

  it('reports every missing required param, not just the first', () => {
    const entries = entriesOf(validateParams(SPECS, {}));
    expect(entries.map((entry) => entry.field)).toEqual(['companyId', 'from', 'to']);
    expect(entries.every((entry) => entry.code === 'VAL_REQUIRED')).toBe(true);
  });

  it('treats a whitespace-only string as absent too', () => {
    // Otherwise `"  "` becomes an empty company id: a filter nobody can look up
    // and a file scoped to nothing.
    const entries = entriesOf(
      validateParams(SPECS, { companyId: '   ', from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(entries).toEqual([
      expect.objectContaining({ field: 'companyId', code: 'VAL_REQUIRED' }),
    ]);
  });

  it('trims a string param that does carry a value', () => {
    const result = validateParams([{ key: 'note', type: 'string', required: false }], {
      note: '  hello  ',
    });
    expect(result).toEqual({ ok: true, value: { note: 'hello' } });
  });

  it('treats an empty string as absent rather than as a value', () => {
    // api-standards §3: *"empty string is never a valid value — send null or omit"*.
    const entries = entriesOf(
      validateParams(SPECS, { companyId: '', from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(entries).toEqual([
      expect.objectContaining({ field: 'companyId', code: 'VAL_REQUIRED' }),
    ]);
  });

  it('rejects an unknown param instead of ignoring it', () => {
    // A misspelled `branchid` would otherwise widen the file to the whole
    // company and look correct.
    const entries = entriesOf(
      validateParams(SPECS, {
        companyId: COMPANY,
        from: '2026-01-01',
        to: '2026-01-31',
        branchid: COMPANY,
      }),
    );
    expect(entries).toEqual([
      expect.objectContaining({ field: 'branchid', code: 'VAL_INVALID_ENUM' }),
    ]);
  });

  it('refuses a timestamp where a date is declared', () => {
    const entries = entriesOf(
      validateParams(SPECS, { companyId: COMPANY, from: '2026-01-01T00:00:00Z', to: '2026-01-31' }),
    );
    expect(entries).toEqual([
      expect.objectContaining({ field: 'from', code: 'VAL_INVALID_FORMAT' }),
    ]);
  });

  it('refuses a date that does not exist and a malformed uuid', () => {
    const entries = entriesOf(
      validateParams(SPECS, { companyId: 'not-a-uuid', from: '2026-02-30', to: '2026-01-31' }),
    );
    expect(entries.map((entry) => entry.field)).toEqual(['companyId', 'from']);
  });

  it('refuses an enum value outside the set and says what the set is', () => {
    const entries = entriesOf(
      validateParams(SPECS, {
        companyId: COMPANY,
        from: '2026-01-01',
        to: '2026-01-31',
        scope: 'paid',
      }),
    );
    expect(entries[0]).toMatchObject({
      field: 'scope',
      code: 'VAL_INVALID_ENUM',
      params: { allowed: ['all', 'unpaid'] },
    });
  });

  it('refuses a numeric string where an integer is declared', () => {
    const entries = entriesOf(
      validateParams(SPECS, {
        companyId: COMPANY,
        from: '2026-01-01',
        to: '2026-01-31',
        limit: '10',
      }),
    );
    expect(entries[0]).toMatchObject({ field: 'limit', code: 'VAL_INVALID_FORMAT' });
  });

  it('refuses "true" as a boolean — api-standards §4 rule 5 wants the literal', () => {
    const entries = entriesOf(
      validateParams(SPECS, {
        companyId: COMPANY,
        from: '2026-01-01',
        to: '2026-01-31',
        outstandingOnly: 'true',
      }),
    );
    expect(entries[0]).toMatchObject({ field: 'outstandingOnly', code: 'VAL_INVALID_FORMAT' });
  });

  it('accepts a definition that declares no params at all', () => {
    expect(validateParams([], {})).toEqual({ ok: true, value: {} });
  });
});
