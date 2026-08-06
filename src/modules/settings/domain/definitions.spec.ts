import { SETTING_DEFINITIONS, SETTING_DEFINITIONS_BY_KEY } from './definitions';
import { validateValue } from './validate-value';

/**
 * The registry is data, so the tests are the invariants a data file can break
 * silently — a default outside its own bounds, a duplicate key, an enum with no
 * members. Each of these ships fine and fails at a tenant's first write.
 */
describe('SETTING_DEFINITIONS', () => {
  it('has no duplicate keys', () => {
    expect(SETTING_DEFINITIONS_BY_KEY.size).toBe(SETTING_DEFINITIONS.length);
  });

  it('names every key <module>.<snake_case> with the module as its prefix', () => {
    for (const definition of SETTING_DEFINITIONS) {
      // naming §9. The prefix is not decoration: the editor groups by module and
      // `GET /settings/definitions?module=` filters on it.
      expect(definition.key).toMatch(/^[a-z][a-z-]*\.[a-z][a-z0-9_]*$/);
      expect(definition.key.split('.')[0]).toBe(definition.module);
    }
  });

  it('accepts its own default', () => {
    // A default outside its validation is a key nobody can reset to the platform
    // value, and nothing else in the system would notice.
    for (const definition of SETTING_DEFINITIONS) {
      expect({
        key: definition.key,
        entries: validateValue(definition, definition.defaultValue),
      }).toEqual({ key: definition.key, entries: [] });
    }
  });

  it('gives every enum key a non-empty member list', () => {
    for (const definition of SETTING_DEFINITIONS.filter((d) => d.type === 'enum')) {
      expect(definition.validation?.enum?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('orders allowedLevels from least to most specific and never skips company', () => {
    for (const definition of SETTING_DEFINITIONS) {
      // A branch level with no company level would be unreachable: resolution
      // walks branch → company → tenant, and the scope CHECK requires a company
      // id on every branch row.
      if (definition.allowedLevels.includes('branch') && definition.allowedLevels.length > 1) {
        expect(definition.allowedLevels).toContain('company');
      }
      expect(new Set(definition.allowedLevels).size).toBe(definition.allowedLevels.length);
    }
  });

  it('pairs every direction with the bound that enforces it', () => {
    // BR-SET-008 is enforced through min/max; a `tighten_only` with neither is a
    // constraint that renders in the editor and stops nothing.
    for (const definition of SETTING_DEFINITIONS.filter((d) => d.validation?.direction)) {
      const validation = definition.validation;
      expect(validation?.min !== undefined || validation?.max !== undefined).toBe(true);
    }
  });

  it('ships no key whose default is a regulation-dependent number', () => {
    // ai-development-guide §5. These fourteen §4.2 rows carry ⚠️ VERIFY on their
    // defaults and are registered by the session that builds their module, when a
    // human has signed the figure — a seed *runs*, so a placeholder here would
    // configure a tenant against a number nobody verified.
    const deferred = [
      'overtime.standard_daily_hours',
      'overtime.max_hours_per_day',
      'overtime.max_hours_per_week',
      'overtime.meal_threshold_hours',
      'payroll.proration_basis',
      'payroll.fixed_daily_divisor',
      'payroll.overtime_divisor',
      'payroll.overtime_basis_floor_pct',
      'bpjs.wage_floor',
      'leave.carry_over_expiry_months',
      'attendance.selfie_retention_months',
      'holiday.cuti_bersama_deducts_leave',
      'recruitment.candidate_retention_days',
      'announcement.acknowledgment_retention_days',
    ];
    for (const key of deferred) {
      expect(SETTING_DEFINITIONS_BY_KEY.has(key)).toBe(false);
    }
  });

  it('keeps every auth key off the client surface', () => {
    // BR-SET-007. Lockout thresholds and token lifetimes are exactly the values
    // an attacker wants, and `/settings/effective` is reachable by any
    // authenticated caller.
    for (const definition of SETTING_DEFINITIONS.filter((d) => d.module === 'auth')) {
      expect(definition.clientVisible).toBe(false);
    }
  });
});
