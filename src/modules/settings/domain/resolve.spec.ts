import { resolveValue } from './resolve';
import type { SettingDefinition, SettingValueRow } from './setting.types';

/** BR-SET-002 (most-specific-wins) and BR-SET-004 (as-of), which are one function. */
describe('resolveValue', () => {
  const definition: SettingDefinition = {
    key: 'attendance.geofence_radius_m',
    module: 'attendance',
    type: 'integer',
    allowedLevels: ['tenant', 'company', 'branch'],
    defaultValue: 100,
    effectiveDated: false,
    clientVisible: true,
    description: 'Geofence radius',
  };

  function row(over: Partial<SettingValueRow>): SettingValueRow {
    return {
      id: 'v1',
      key: 'attendance.geofence_radius_m',
      level: 'tenant',
      companyId: null,
      branchId: null,
      value: 1,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      ...over,
    };
  }

  const scope = { companyId: 'c1', branchId: 'b1' };

  it('falls back to the definition default when nothing is set', () => {
    expect(resolveValue(definition, [], scope, '2026-08-06')).toEqual({
      value: 100,
      origin: 'default',
    });
  });

  it('lets branch beat company beat tenant', () => {
    const rows = [
      row({ id: 't', level: 'tenant', value: 10 }),
      row({ id: 'c', level: 'company', companyId: 'c1', value: 20 }),
      row({ id: 'b', level: 'branch', companyId: 'c1', branchId: 'b1', value: 30 }),
    ];
    expect(resolveValue(definition, rows, scope, '2026-08-06')).toEqual({
      value: 30,
      origin: 'branch',
    });
  });

  it('skips a missing intermediate level cleanly', () => {
    // The chain is not a ladder that has to be climbed rung by rung — a tenant
    // value with no company row still wins over the default for a branch caller.
    const rows = [row({ id: 't', level: 'tenant', value: 10 })];
    expect(resolveValue(definition, rows, scope, '2026-08-06')).toEqual({
      value: 10,
      origin: 'tenant',
    });
  });

  it('ignores rows belonging to another company or branch', () => {
    // Rows for a sibling scope arrive in the same query when a caller reads
    // several branches; picking on level alone would return another site's radius.
    const rows = [
      row({ id: 'other-c', level: 'company', companyId: 'c2', value: 20 }),
      row({ id: 'other-b', level: 'branch', companyId: 'c1', branchId: 'b2', value: 30 }),
      row({ id: 't', level: 'tenant', value: 10 }),
    ];
    expect(resolveValue(definition, rows, scope, '2026-08-06')).toEqual({
      value: 10,
      origin: 'tenant',
    });
  });

  it('resolves at tenant scope for a caller with no placement', () => {
    // UC-SET-005: a pure admin user has no employee row, so company and branch
    // rows are not theirs to inherit.
    const rows = [
      row({ id: 'c', level: 'company', companyId: 'c1', value: 20 }),
      row({ id: 't', level: 'tenant', value: 10 }),
    ];
    expect(resolveValue(definition, rows, {}, '2026-08-06')).toEqual({
      value: 10,
      origin: 'tenant',
    });
  });

  describe('as-of (BR-SET-004)', () => {
    const dated: SettingValueRow[] = [
      row({ id: 'h1', value: 10, effectiveFrom: '2026-01-01', effectiveTo: '2026-04-01' }),
      row({ id: 'h2', value: 20, effectiveFrom: '2026-04-01', effectiveTo: '2026-07-01' }),
      row({ id: 'live', value: 30, effectiveFrom: '2026-07-01', effectiveTo: null }),
    ];

    it('returns the row live at the asked date, not the newest', () => {
      // This is payroll determinism: re-running May reads May's value.
      expect(resolveValue(definition, dated, {}, '2026-05-15').value).toBe(20);
    });

    it('treats the interval as half-open — the boundary date belongs to the successor', () => {
      expect(resolveValue(definition, dated, {}, '2026-04-01').value).toBe(20);
      expect(resolveValue(definition, dated, {}, '2026-03-31').value).toBe(10);
    });

    it('ignores a scheduled row until its date arrives', () => {
      const scheduled = [
        row({ id: 'live', value: 30, effectiveFrom: '2026-07-01', effectiveTo: '2026-09-01' }),
        row({ id: 'future', value: 40, effectiveFrom: '2026-09-01', effectiveTo: null }),
      ];
      expect(resolveValue(definition, scheduled, {}, '2026-08-06').value).toBe(30);
      expect(resolveValue(definition, scheduled, {}, '2026-09-01').value).toBe(40);
    });

    it('falls to the default before the first row takes effect', () => {
      expect(resolveValue(definition, dated, {}, '2025-12-31')).toEqual({
        value: 100,
        origin: 'default',
      });
    });
  });

  it('skips levels the definition no longer allows', () => {
    // §9: `allowedLevels` narrowed in a release. The old rows stay historically
    // valid, and resolution stops consulting them rather than silently keeping a
    // level the definition says no longer exists.
    const tenantOnly = { ...definition, allowedLevels: ['tenant'] as const };
    const rows = [
      row({ id: 'b', level: 'branch', companyId: 'c1', branchId: 'b1', value: 30 }),
      row({ id: 't', level: 'tenant', value: 10 }),
    ];
    expect(
      resolveValue({ ...tenantOnly, allowedLevels: ['tenant'] }, rows, scope, '2026-08-06'),
    ).toEqual({ value: 10, origin: 'tenant' });
  });
});
