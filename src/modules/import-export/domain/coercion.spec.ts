import { coerce, isEmptyRow, runValidators, textOf } from './coercion';
import type { ImportColumn } from './definitions';
import type { CellValue } from './import-export.types';

function column(overrides: Partial<ImportColumn> & Pick<ImportColumn, 'type'>): ImportColumn {
  return {
    key: 'value',
    header: { id: 'Nilai', en: 'Value' },
    required: false,
    ...overrides,
  };
}

function value(type: ImportColumn['type'], raw: unknown, extra?: Partial<ImportColumn>) {
  const result = coerce(column({ type, ...extra }), raw);
  return result.ok ? result.value : null;
}

function errorCode(type: ImportColumn['type'], raw: unknown, extra?: Partial<ImportColumn>) {
  const result = coerce(column({ type, ...extra }), raw);
  return result.ok ? null : result.error.code;
}

describe('BR-IMP-008 coercion', () => {
  describe('absence', () => {
    it('treats null, undefined and blank as absent', () => {
      for (const raw of [null, undefined, '', '   ']) {
        expect(value('string', raw)).toBeNull();
      }
    });

    it('refuses an absent value on a required column', () => {
      expect(errorCode('string', null, { required: true })).toBe('VAL_REQUIRED');
    });

    it('accepts an absent value on an optional column', () => {
      expect(coerce(column({ type: 'string' }), null)).toEqual({ ok: true, value: null });
    });
  });

  describe('formula and rich-text cells', () => {
    it('takes a formula cell’s cached result and never the formula', () => {
      expect(value('string', { formula: 'A1&B1', result: 'Budi' })).toBe('Budi');
    });

    it('reads a cached numeric result as a number', () => {
      expect(value('integer', { formula: 'SUM(A1:A2)', result: 7 })).toBe(7);
    });

    it('treats an Excel error result as absent rather than as text', () => {
      // `#N/A` has no value; the column's own `required` decides what that means.
      expect(value('string', { error: '#N/A' })).toBeNull();
      expect(errorCode('string', { error: '#N/A' }, { required: true })).toBe('VAL_REQUIRED');
    });

    it('flattens rich text runs into one string', () => {
      expect(value('string', { richText: [{ text: 'Bu' }, { text: 'di' }] })).toBe('Budi');
    });

    it('reads a hyperlink cell’s text', () => {
      expect(value('string', { text: 'nik-1', hyperlink: 'https://x' })).toBe('nik-1');
    });
  });

  describe('string', () => {
    it('trims', () => {
      expect(value('string', '  Budi  ')).toBe('Budi');
    });
  });

  describe('date — §14: an Excel serial and an ISO string give the same result', () => {
    it('normalizes a serial and an ISO string to the same day', () => {
      // 45,000 is 2023-03-15 under Excel's 1899-12-30 epoch.
      expect(value('date', 45_000)).toBe('2023-03-15');
      expect(value('date', '2023-03-15')).toBe('2023-03-15');
      expect(value('date', 45_000)).toBe(value('date', '2023-03-15'));
    });

    it('accepts a native Date cell', () => {
      expect(value('date', new Date('2026-08-10T09:30:00Z'))).toBe('2026-08-10');
    });

    it('truncates a serial’s time-of-day fraction', () => {
      expect(value('date', 45_000.75)).toBe('2023-03-15');
    });

    it('takes the date half of a full ISO instant', () => {
      expect(value('date', '2026-08-10T23:59:59Z')).toBe('2026-08-10');
    });

    it('refuses DD/MM/YYYY rather than guessing which half is the month', () => {
      expect(errorCode('date', '03/04/2026')).toBe('VAL_INVALID_FORMAT');
    });

    it('refuses a day that does not exist', () => {
      expect(errorCode('date', '2026-02-30')).toBe('VAL_INVALID_FORMAT');
    });
  });

  describe('decimal — the id-ID comma trap', () => {
    it('§14: refuses "1.234,56" with a format error naming the expected form', () => {
      const result = coerce(column({ type: 'decimal' }), '1.234,56');
      expect(result).toEqual({
        ok: false,
        error: { column: 'value', code: 'VAL_INVALID_FORMAT', params: { expected: '1234.56' } },
      });
    });

    it('refuses a bare thousands comma too — the same ambiguity', () => {
      expect(errorCode('decimal', '1,234')).toBe('VAL_INVALID_FORMAT');
    });

    it('keeps a decimal as a string so no rupiah is lost to a float', () => {
      expect(value('decimal', '12500000.55')).toBe('12500000.55');
      expect(typeof value('decimal', 1234.56)).toBe('string');
    });

    it('accepts a negative amount', () => {
      expect(value('decimal', '-2.5')).toBe('-2.5');
    });

    it('refuses a number so large it stringifies to exponent notation', () => {
      expect(errorCode('decimal', 1e21)).toBe('VAL_INVALID_FORMAT');
    });
  });

  describe('integer', () => {
    it('accepts an integer from either a number or a string', () => {
      expect(value('integer', 42)).toBe(42);
      expect(value('integer', ' 42 ')).toBe(42);
    });

    it('refuses a fractional value rather than rounding it', () => {
      expect(errorCode('integer', 4.5)).toBe('VAL_INVALID_FORMAT');
      expect(errorCode('integer', '4.5')).toBe('VAL_INVALID_FORMAT');
    });
  });

  describe('boolean', () => {
    it('accepts both languages and both notations', () => {
      for (const raw of [true, 'TRUE', '1', 'Ya', 'yes']) {
        expect(value('boolean', raw)).toBe(true);
      }
      for (const raw of [false, 'false', '0', 'Tidak', 'no']) {
        expect(value('boolean', raw)).toBe(false);
      }
    });

    it('refuses anything else with the allowed vocabulary attached', () => {
      const result = coerce(column({ type: 'boolean' }), 'mungkin');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VAL_INVALID_ENUM');
        expect(result.error.params?.allowed).toContain('ya');
      }
    });
  });

  describe('enum', () => {
    const options = { enumValues: ['national', 'cuti_bersama'] };

    it('matches case-insensitively and returns the canonical spelling', () => {
      expect(value('enum', 'NATIONAL', options)).toBe('national');
    });

    it('refuses a value outside the set and reports the set', () => {
      const result = coerce(column({ type: 'enum', ...options }), 'custom');
      expect(result).toEqual({
        ok: false,
        error: {
          column: 'value',
          code: 'VAL_INVALID_ENUM',
          params: { allowed: ['national', 'cuti_bersama'] },
        },
      });
    });
  });
});

describe('isEmptyRow', () => {
  it('is true for a row of blanks, whitespace and Excel errors', () => {
    expect(isEmptyRow({ a: null, b: '   ', c: undefined, d: { error: '#REF!' } })).toBe(true);
  });

  it('is false as soon as one cell carries anything', () => {
    expect(isEmptyRow({ a: null, b: 0 })).toBe(false);
  });
});

describe('runValidators', () => {
  const row = { rowNumber: 2, values: {} as Record<string, CellValue> };

  it('does not run a validator against an absent value', () => {
    const validator = jest.fn();
    expect(runValidators([validator], null, row)).toEqual([]);
    expect(validator).not.toHaveBeenCalled();
  });

  it('collects every validator’s verdict rather than stopping at the first', () => {
    const errors = runValidators(
      [
        () => ({ column: 'nik', code: 'EMP_NIK_INVALID' }),
        () => null,
        () => ({ column: 'nik', code: 'VAL_TOO_LONG' }),
      ],
      '123',
      row,
    );
    expect(errors.map((error) => error.code)).toEqual(['EMP_NIK_INVALID', 'VAL_TOO_LONG']);
  });
});

describe('textOf', () => {
  it('never yields [object Object] for a structured cell', () => {
    expect(textOf({ richText: [] })).toBe('');
    expect(textOf(7)).toBe('7');
    expect(textOf('x')).toBe('x');
  });
});
