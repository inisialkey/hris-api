import { finalPath, sanitizeFileName, stagingPath } from './storage-path';

const TENANT = '01931b7c-0000-7000-8000-0000000000t1';
const ENTITY = '01931b7c-0000-7000-8000-0000000000e1';
const FILE = '01931b7c-0000-7000-8000-0000000000f1';

describe('file name sanitation (§8, BR-DOC-012)', () => {
  it('strips path separators rather than rejecting the upload', () => {
    // §8 is explicit that this is sanitation, not a validation failure: the user
    // picked a file, and the name is ours to make safe.
    expect(sanitizeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeFileName('C:\\Users\\me\\ktp.jpg')).toBe('C_Users_me_ktp.jpg');
  });

  it('strips control characters, which is how a path grammar gets broken', () => {
    expect(sanitizeFileName('ktp\u0000.jpg')).toBe('ktp.jpg');
    expect(sanitizeFileName('scan\n\tcopy.pdf')).toBe('scan_copy.pdf');
  });

  it('keeps a name a person would recognise', () => {
    expect(sanitizeFileName('KTP Budi Santoso (2026).pdf')).toBe('KTP Budi Santoso (2026).pdf');
  });

  it('never returns empty, because the path grammar has a slot to fill', () => {
    expect(sanitizeFileName('...')).toBe('file');
    expect(sanitizeFileName('   ')).toBe('file');
  });

  it('bounds the name so the generated path cannot outgrow the column', () => {
    expect(sanitizeFileName('a'.repeat(400))).toHaveLength(255);
  });
});

describe('path generation (naming §11.4, ADR-0009)', () => {
  it('builds the final path exactly as the grammar states it', () => {
    expect(finalPath(TENANT, 'employee', ENTITY, FILE, 'ktp.jpg')).toBe(
      `tenants/${TENANT}/employee/${ENTITY}/${FILE}_ktp.jpg`,
    );
  });

  it('puts staged objects under the lifecycle-managed prefix', () => {
    // The 24 h auto-delete is a bucket rule on this prefix (BR-DOC-003); a
    // staged object written anywhere else would never expire.
    expect(stagingPath(TENANT, 'employee', ENTITY, FILE, 'ktp.jpg')).toBe(
      `uploads/${TENANT}/employee/${ENTITY}/${FILE}_ktp.jpg`,
    );
  });

  it('carries the tenant prefix on both paths — a leaked path grants nothing', () => {
    for (const path of [
      finalPath(TENANT, 'employee', ENTITY, FILE, 'x.pdf'),
      stagingPath(TENANT, 'employee', ENTITY, FILE, 'x.pdf'),
    ]) {
      expect(path).toContain(TENANT);
    }
  });

  it('sanitizes on the way in, so no caller can forget to', () => {
    expect(finalPath(TENANT, 'employee', ENTITY, FILE, '../../../secret.pdf')).toBe(
      `tenants/${TENANT}/employee/${ENTITY}/${FILE}_secret.pdf`,
    );
  });
});
