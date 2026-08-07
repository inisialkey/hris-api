import { HEAD_BYTES, sniff, sniffedLabel } from './mime';

const head = (...bytes: number[]) => Buffer.from(bytes);

/** A minimal well-formed local file header naming one entry. */
const zipEntry = (name: string) =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(22),
    Buffer.from(name, 'latin1'),
  ]);

describe('magic-byte sniffing (BR-DOC-005)', () => {
  it('recognises the three types every client-facing category allows', () => {
    expect(sniff(head(0xff, 0xd8, 0xff, 0xe0))).toEqual(['image/jpeg']);
    expect(sniff(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual(['image/png']);
    expect(sniff(Buffer.from('%PDF-1.7\n'))).toEqual(['application/pdf']);
  });

  it('ignores the extension entirely — the name is not an input', () => {
    // The whole point of BR-DOC-005: `payslip.pdf` holding png bytes sniffs png.
    expect(sniff(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual(['image/png']);
  });

  it('returns nothing for bytes it does not know', () => {
    expect(sniff(Buffer.from('not a file at all'))).toEqual([]);
    expect(sniff(Buffer.alloc(0))).toEqual([]);
  });

  it('reads a zip as both OOXML candidates until an entry name decides', () => {
    const bare = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]);
    expect(sniff(bare)).toHaveLength(2);
  });

  it('separates xlsx from docx on the first entry name in the buffer', () => {
    expect(sniff(zipEntry('xl/workbook.xml'))).toEqual([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    expect(sniff(zipEntry('word/document.xml'))).toEqual([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
  });

  it('reads far enough to reach a second local header', () => {
    // `[Content_Types].xml` is written first and says nothing about the format;
    // the entry that names it comes after, which is why the read is not 8 bytes.
    expect(HEAD_BYTES).toBeGreaterThanOrEqual(4096);
  });

  it('labels an unrecognised head rather than leaving `sniffed` empty', () => {
    expect(sniffedLabel(Buffer.from('garbage'))).toBe('application/octet-stream');
    expect(sniffedLabel(Buffer.from('%PDF-1.4'))).toBe('application/pdf');
  });
});
