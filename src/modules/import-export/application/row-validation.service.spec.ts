import { AppError } from '../../../shared/app-error';
import { fail, ok } from '../../../shared/result';
import type { SheetRow } from '../domain/import-export.ports';
import type { ParsedRow, RowError } from '../domain/import-export.types';
import { RowValidationService } from './row-validation.service';
import { importDefinition } from './test-support';

const service = new RowValidationService();

function sheet(...rows: [number, ...unknown[]][]): SheetRow[] {
  return rows.map(([rowNumber, ...cells]) => ({ rowNumber, cells }));
}

describe('RowValidationService — BR-IMP-002’s one validation path', () => {
  it('coerces by position and reports the whole row’s failures together', async () => {
    const pass = await service.run(
      importDefinition(),
      sheet([2, '3201', 'Budi', '2026-01-05'], [3, '', 'Siti', 'kemarin']),
    );

    expect(pass.report).toMatchObject({ totalRows: 2, validRows: 1, errorRows: 1 });
    expect(pass.report.verdicts[0]).toEqual({
      rowNumber: 3,
      errors: [
        { column: 'nik', code: 'VAL_REQUIRED' },
        { column: 'joinDate', code: 'VAL_INVALID_FORMAT', params: { expected: 'YYYY-MM-DD' } },
      ],
    });
    expect(pass.validRows.map((row) => row.rowNumber)).toEqual([2]);
  });

  it('skips a fully-empty row rather than counting it or reporting it', async () => {
    const pass = await service.run(
      importDefinition(),
      sheet([2, '3201', 'Budi', '2026-01-05'], [3, null, '  ', undefined]),
    );
    expect(pass.report.totalRows).toBe(1);
    expect(pass.report.verdicts).toEqual([]);
  });

  it('§9: flags BOTH rows of an in-file natural-key collision', async () => {
    const pass = await service.run(
      importDefinition(),
      sheet(
        [2, '3201', 'Budi', '2026-01-05'],
        [3, '3202', 'Siti', '2026-01-05'],
        [4, '3201', 'Budi Lain', '2026-02-01'],
      ),
    );

    expect(pass.report.verdicts.map((verdict) => verdict.rowNumber)).toEqual([2, 4]);
    expect(pass.report.verdicts[0]!.errors[0]).toEqual({
      column: 'nik',
      code: 'VAL_DUPLICATE',
      params: { field: 'nik' },
    });
    // Never last-writer-wins: neither row is applicable.
    expect(pass.validRows.map((row) => row.rowNumber)).toEqual([3]);
  });

  it('compares natural keys case-insensitively', async () => {
    const pass = await service.run(
      importDefinition({ naturalKey: ['name'] }),
      sheet([2, '3201', 'budi', '2026-01-05'], [3, '3202', 'BUDI', '2026-01-05']),
    );
    expect(pass.report.errorRows).toBe(2);
  });

  it('does not call a row a duplicate when its key cell is missing', async () => {
    // The missing cell is already that row's verdict; a second error for one
    // mistake reads as two problems.
    const pass = await service.run(
      importDefinition(),
      sheet([2, '', 'Budi', '2026-01-05'], [3, '', 'Siti', '2026-01-05']),
    );
    const codes = pass.report.verdicts.flatMap((verdict) =>
      verdict.errors.map((error) => error.code),
    );
    expect(codes).toEqual(['VAL_REQUIRED', 'VAL_REQUIRED']);
  });

  it('runs a definition’s cross-row validator over every parsed row', async () => {
    const seen: ParsedRow[][] = [];
    const pass = await service.run(
      importDefinition({
        crossRowValidators: [
          (rows) => {
            seen.push([...rows]);
            return [{ rowNumber: 2, errors: [{ column: null, code: 'PRF_WEIGHT_UNBALANCED' }] }];
          },
        ],
      }),
      sheet([2, '3201', 'Budi', '2026-01-05'], [3, '3202', 'Siti', '2026-01-05']),
    );

    expect(seen[0]).toHaveLength(2);
    expect(pass.report.verdicts[0]!.errors[0]!.code).toBe('PRF_WEIGHT_UNBALANCED');
  });

  it('runs the handler’s database checks only on rows nothing else refused', async () => {
    const checked: number[] = [];
    const pass = await service.run(
      importDefinition({
        rowHandler: {
          check: (row) => {
            checked.push(row.rowNumber);
            const errors: RowError[] =
              row.values.nik === '3202' ? [{ column: 'nik', code: 'EMP_DUPLICATE_NIK' }] : [];
            return Promise.resolve(errors);
          },
          apply: () => Promise.resolve(ok(undefined)),
        },
      }),
      sheet(
        [2, '3201', 'Budi', '2026-01-05'],
        [3, '3202', 'Siti', '2026-01-05'],
        [4, '', 'Tono', '2026-01-05'],
      ),
    );

    // Row 4 already failed coercion, so it costs no lookup.
    expect(checked).toEqual([2, 3]);
    expect(pass.report.errorRows).toBe(2);
    expect(pass.validRows.map((row) => row.rowNumber)).toEqual([2]);
  });

  it('runs a definition with no handler check at all', async () => {
    const pass = await service.run(
      importDefinition({
        rowHandler: { apply: () => Promise.resolve(fail(new AppError('EMP_DUPLICATE_NIK'))) },
      }),
      sheet([2, '3201', 'Budi', '2026-01-05']),
    );
    expect(pass.report).toMatchObject({ totalRows: 1, validRows: 1, errorRows: 0 });
  });

  it('runs a declared column validator and attributes its verdict to that column', async () => {
    const pass = await service.run(
      importDefinition({
        columns: [
          {
            key: 'nik',
            header: { id: 'NIK', en: 'NIK' },
            type: 'string',
            required: true,
            validators: [
              (value) =>
                String(value).length === 16
                  ? null
                  : { column: 'nik', code: 'VAL_TOO_SHORT', params: { min: 16 } },
            ],
          },
        ],
        naturalKey: ['nik'],
      }),
      sheet([2, '3201']),
    );
    expect(pass.report.verdicts[0]!.errors[0]).toMatchObject({ code: 'VAL_TOO_SHORT' });
  });

  it('returns verdicts in row order however they were collected', async () => {
    const pass = await service.run(
      importDefinition({
        crossRowValidators: [() => [{ rowNumber: 2, errors: [{ column: null, code: 'X_LATE' }] }]],
      }),
      sheet([2, '3201', 'Budi', '2026-01-05'], [3, '3202', '', '2026-01-05']),
    );
    expect(pass.report.verdicts.map((verdict) => verdict.rowNumber)).toEqual([2, 3]);
  });
});
