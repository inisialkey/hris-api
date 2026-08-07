/**
 * BR-DOC-005 layer 2 — the magic-byte sniff.
 *
 * *"extension is never consulted"*, and neither is the client's declared type:
 * this reads bytes and answers what they are. The declared value is compared
 * against the answer by the caller, which is what makes `DOC_MIME_MISMATCH` a
 * statement about the object rather than about the request.
 */

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * How much of the object the confirm step reads.
 *
 * A signature is at most eight bytes, so this is sized for the one format that
 * needs more: an OOXML file is a zip, and telling a workbook from a document
 * means reaching the local file header that names `xl/…` or `word/…`. Office
 * writes `[Content_Types].xml` first, so the deciding entry is the second one —
 * comfortably inside 4 KB, and cheap enough to read on every commit.
 */
export const HEAD_BYTES = 4096;

interface Signature {
  readonly magic: readonly number[];
  readonly mimes: readonly string[];
}

const SIGNATURES: readonly Signature[] = [
  { magic: [0xff, 0xd8, 0xff], mimes: ['image/jpeg'] },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mimes: ['image/png'] },
  { magic: [0x25, 0x50, 0x44, 0x46, 0x2d], mimes: ['application/pdf'] }, // %PDF-
  // Both OOXML types are zips and share this header. Narrowed below when an
  // entry name is in range; left ambiguous when it is not, because two
  // candidates is the honest answer and guessing one would reject a valid file.
  { magic: [0x50, 0x4b, 0x03, 0x04], mimes: [XLSX, DOCX] },
];

/** Entry-name prefixes that decide an OOXML zip, in the order they are tried. */
const OOXML_MARKERS: readonly (readonly [string, string])[] = [
  ['xl/', XLSX],
  ['word/', DOCX],
];

/**
 * Every mime the head could belong to. Empty means *"nothing this system
 * accepts"*, which is a mismatch against any declared value.
 */
export function sniff(head: Buffer): readonly string[] {
  const match = SIGNATURES.find((signature) => starts(head, signature.magic));
  if (!match) return [];
  if (match.mimes.length === 1) return match.mimes;

  // Zip entry names are stored uncompressed in the local headers, so a plain
  // scan of the buffer is enough — no inflate, no zip parser.
  const text = head.toString('latin1');
  const marker = OOXML_MARKERS.find(([prefix]) => text.includes(prefix));
  return marker ? [marker[1]] : match.mimes;
}

/** The `details.sniffed` value of `DOC_MIME_MISMATCH` (§7). */
export function sniffedLabel(head: Buffer): string {
  return sniff(head)[0] ?? 'application/octet-stream';
}

function starts(head: Buffer, magic: readonly number[]): boolean {
  if (head.length < magic.length) return false;
  return magic.every((byte, index) => head[index] === byte);
}
