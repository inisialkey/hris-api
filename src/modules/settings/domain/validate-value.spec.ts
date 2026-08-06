import { validateValue } from './validate-value';
import type { SettingDefinition } from './setting.types';

/** §8's `value` row: type match, then bounds, then enum, then pattern. */
describe('validateValue', () => {
  function definition(over: Partial<SettingDefinition>): SettingDefinition {
    return {
      key: 'test.key',
      module: 'test',
      type: 'integer',
      allowedLevels: ['tenant'],
      defaultValue: 1,
      effectiveDated: false,
      clientVisible: false,
      description: 'test',
      ...over,
    };
  }

  const codes = (entries: { code: string }[]) => entries.map((e) => e.code);

  describe('type', () => {
    const cases: [SettingDefinition['type'], unknown, boolean][] = [
      ['boolean', true, true],
      ['boolean', 'true', false],
      ['integer', 5, true],
      ['integer', 5.5, false],
      ['integer', '5', false],
      // Money and rates cross the wire as decimal strings (ADR-0007, §7's
      // request table) — a float here is the precision loss that convention
      // exists to prevent, so it is rejected rather than coerced.
      ['decimal', '5.50', true],
      ['decimal', 5.5, false],
      ['decimal', 'abc', false],
      ['string', 'x', true],
      ['string', 5, false],
      ['json', { a: 1 }, true],
    ];

    it.each(cases)('%s accepts %p → %p', (type, value, valid) => {
      const entries = validateValue(definition({ type }), value);
      expect(entries.length === 0).toBe(valid);
      if (!valid) expect(codes(entries)).toEqual(['VAL_INVALID_FORMAT']);
    });
  });

  describe('bounds', () => {
    const bounded = definition({ validation: { min: 3, max: 5 } });

    it('accepts a value inside the range', () => {
      expect(validateValue(bounded, 4)).toEqual([]);
    });

    it.each([
      [2, { min: 3, max: 5 }],
      [6, { min: 3, max: 5 }],
    ])('refuses %p with the platform bound in details', (value, params) => {
      const entries = validateValue(bounded, value);
      expect(codes(entries)).toEqual(['VAL_OUT_OF_RANGE']);
      // BR-SET-008 wants the bound *in the error* — the editor renders
      // "minimum 10 — platform floor" from it, and a bare refusal cannot.
      expect(entries[0]?.params).toEqual(params);
    });

    it('applies bounds to decimal strings without going through a float', () => {
      const money = definition({ type: 'decimal', validation: { min: 0 } });
      expect(validateValue(money, '-1.00')).toEqual([
        expect.objectContaining({ code: 'VAL_OUT_OF_RANGE' }),
      ]);
      expect(validateValue(money, '0.00')).toEqual([]);
    });
  });

  describe('tighten_only (BR-SET-008)', () => {
    // The direction is carried for the editor to render; the *enforcement* is
    // the bound, because every registered row expresses tightening as a floor or
    // a ceiling and two mechanisms for one rule is how they disagree.
    const minLength = definition({
      key: 'auth.password_min_length',
      validation: { min: 10, direction: 'tighten_only' },
    });

    it('lets a tenant raise the floor', () => {
      expect(validateValue(minLength, 12)).toEqual([]);
    });

    it('refuses a tenant lowering it below the platform floor', () => {
      const entries = validateValue(minLength, 8);
      expect(codes(entries)).toEqual(['VAL_OUT_OF_RANGE']);
      expect(entries[0]?.params).toEqual({ min: 10 });
    });
  });

  describe('enum', () => {
    const choice = definition({
      type: 'enum',
      validation: { enum: ['self_service', 'admin'] },
      defaultValue: 'self_service',
    });

    it('accepts a listed member', () => {
      expect(validateValue(choice, 'admin')).toEqual([]);
    });

    it('refuses anything else with the allowed set', () => {
      const entries = validateValue(choice, 'whatever');
      expect(codes(entries)).toEqual(['VAL_INVALID_ENUM']);
      expect(entries[0]?.params).toEqual({ allowed: ['self_service', 'admin'] });
    });
  });

  describe('pattern', () => {
    const csv = definition({
      key: 'employee.contract_reminder_days',
      type: 'string',
      validation: { pattern: '^\\d+(,\\d+)*$' },
      defaultValue: '60,30',
    });

    it('accepts a matching string', () => {
      expect(validateValue(csv, '90,60,30')).toEqual([]);
    });

    it('refuses a non-matching one', () => {
      expect(codes(validateValue(csv, '60;30'))).toEqual(['VAL_INVALID_FORMAT']);
    });
  });

  it('stops at the type failure rather than piling on bound complaints', () => {
    // `'abc' < 3` is `false` in JavaScript, so a naive chain would report the
    // string as in-range and confuse the caller about which field is wrong.
    const entries = validateValue(definition({ validation: { min: 3 } }), 'abc');
    expect(codes(entries)).toEqual(['VAL_INVALID_FORMAT']);
  });
});
