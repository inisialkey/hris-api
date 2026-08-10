import { ok } from '../../../shared/result';
import {
  clearDefinitions,
  entitledColumns,
  findExportDefinition,
  findImportDefinition,
  listImportDefinitions,
  registerExportDefinition,
  registerImportDefinition,
  type ExportDefinition,
  type ImportColumn,
  type ImportDefinition,
} from './definitions';

const text = (value: string) => ({ id: value, en: value });

function importDefinition(overrides: Partial<ImportDefinition> = {}): ImportDefinition {
  const columns: ImportColumn[] = [
    { key: 'nik', header: text('NIK'), type: 'string', required: true },
    { key: 'name', header: text('Nama'), type: 'string', required: true },
  ];
  return {
    key: 'employee.master',
    requiredPermission: 'employee.master.import',
    templateVersion: 1,
    columns,
    naturalKey: ['nik'],
    writeMode: 'create_only',
    commitMode: 'partial',
    rowHandler: { apply: () => Promise.resolve(ok(undefined)) },
    ...overrides,
  };
}

function exportDefinition(overrides: Partial<ExportDefinition> = {}): ExportDefinition {
  return {
    key: 'employee.master',
    requiredPermission: 'employee.master.export',
    params: [{ key: 'companyId', type: 'uuid', required: true }],
    columnSets: { base: [{ key: 'number', header: text('Nomor') }] },

    queryPort: { stream: async function* () {} },
    ...overrides,
  };
}

describe('the definition registry (BR-IMP-001)', () => {
  beforeEach(() => clearDefinitions());

  it('holds nothing until a module registers — a key with no definition is not live', () => {
    expect(listImportDefinitions()).toEqual([]);
    expect(findImportDefinition('employee.master')).toBeNull();
    expect(findExportDefinition('employee.master')).toBeNull();
  });

  it('lets one key be both an import and an export', () => {
    // `employee.master`, `asset.registry` and `training.certification` all are —
    // two registries rather than one is what makes that expressible.
    registerImportDefinition(importDefinition());
    registerExportDefinition(exportDefinition());
    expect(findImportDefinition('employee.master')).not.toBeNull();
    expect(findExportDefinition('employee.master')).not.toBeNull();
  });

  it('refuses a second claim on one key, in either registry', () => {
    registerImportDefinition(importDefinition());
    expect(() => registerImportDefinition(importDefinition())).toThrow(/already registered/);
    registerExportDefinition(exportDefinition());
    expect(() => registerExportDefinition(exportDefinition())).toThrow(/already registered/);
  });

  it('refuses a key that is not <ns>.<subject>', () => {
    for (const key of ['employee', 'Employee.Master', 'employee master', '.master']) {
      expect(() => registerImportDefinition(importDefinition({ key }))).toThrow(/naming §4/);
    }
  });

  it('refuses a natural key naming a column the template does not carry', () => {
    // Every row would look unique, so nothing would ever be reported as an
    // in-file duplicate — the silent version of §9's collision case.
    expect(() => registerImportDefinition(importDefinition({ naturalKey: ['npwp'] }))).toThrow(
      /unknown column npwp/,
    );
  });

  it('refuses a duplicate column key and an empty column list', () => {
    const duplicated = importDefinition().columns[0]!;
    expect(() =>
      registerImportDefinition(importDefinition({ columns: [duplicated, duplicated] })),
    ).toThrow(/twice/);
    expect(() => registerImportDefinition(importDefinition({ columns: [] }))).toThrow(/no columns/);
  });

  it('refuses an enum column with no values and a non-enum column that declares some', () => {
    expect(() =>
      registerImportDefinition(
        importDefinition({
          columns: [{ key: 'kind', header: text('Jenis'), type: 'enum', required: true }],
          naturalKey: [],
        }),
      ),
    ).toThrow(/enum with no values/);

    expect(() =>
      registerImportDefinition(
        importDefinition({
          columns: [
            { key: 'nik', header: text('NIK'), type: 'string', required: true, enumValues: ['a'] },
          ],
        }),
      ),
    ).toThrow(/enumValues on a string/);
  });

  it('accepts a definition with no natural key — leave.balance_adjustment has none', () => {
    expect(() =>
      registerImportDefinition(
        importDefinition({ key: 'leave.balance_adjustment', naturalKey: [] }),
      ),
    ).not.toThrow();
  });

  it('lists definitions in key order so the catalog is stable between calls', () => {
    registerImportDefinition(importDefinition({ key: 'shift.roster' }));
    registerImportDefinition(importDefinition({ key: 'employee.master' }));
    registerImportDefinition(importDefinition({ key: 'holiday.calendar' }));
    expect(listImportDefinitions().map((definition) => definition.key)).toEqual([
      'employee.master',
      'holiday.calendar',
      'shift.roster',
    ]);
  });

  it('accepts an export with no base columns only when it resolves them per params', () => {
    expect(() => registerExportDefinition(exportDefinition({ columnSets: { base: [] } }))).toThrow(
      /no base columns/,
    );
    clearDefinitions();
    expect(() =>
      registerExportDefinition(
        exportDefinition({
          key: 'report.result',
          columnSets: { base: [] },
          resolve: () =>
            Promise.resolve({
              requiredPermission: 'report.result.read',
              columnSets: { base: [{ key: 'x', header: text('X') }] },

              queryPort: { stream: async function* () {} },
            }),
        }),
      ),
    ).not.toThrow();
  });

  it('refuses an enum param with no values', () => {
    expect(() =>
      registerExportDefinition(
        exportDefinition({ params: [{ key: 'scope', type: 'enum', required: true }] }),
      ),
    ).toThrow(/enum with no values/);
  });
});

describe('entitledColumns (BR-IMP-010)', () => {
  const sets = {
    base: [
      { key: 'number', header: text('Nomor') },
      { key: 'name', header: text('Nama') },
    ],
    gated: [
      { permission: 'employee.sensitive.read', columns: [{ key: 'nik', header: text('NIK') }] },
      { permission: 'payroll.run.export', columns: [{ key: 'net', header: text('Neto') }] },
    ],
  };

  it('yields the base set alone to a holder of neither gated permission', () => {
    const entitlement = entitledColumns(sets, new Set());
    expect(entitlement.columns.map((column) => column.key)).toEqual(['number', 'name']);
    expect(entitlement.gated).toBe(false);
  });

  it('appends only the gated sets the caller holds, and flags the file as gated', () => {
    const entitlement = entitledColumns(sets, new Set(['payroll.run.export']));
    expect(entitlement.columns.map((column) => column.key)).toEqual(['number', 'name', 'net']);
    expect(entitlement.gated).toBe(true);
  });

  it('keeps declaration order so two requesters’ files line up column for column', () => {
    const both = entitledColumns(sets, new Set(['payroll.run.export', 'employee.sensitive.read']));
    expect(both.columns.map((column) => column.key)).toEqual(['number', 'name', 'nik', 'net']);
  });
});
