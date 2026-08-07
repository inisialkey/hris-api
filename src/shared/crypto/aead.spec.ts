import { randomBytes } from 'node:crypto';

import { CipherFormatError, open, seal, versionOf } from './aead';

describe('ADR-0016 AEAD envelope', () => {
  const key = randomBytes(32);

  it('round-trips a value', () => {
    expect(open(key, seal(key, '3201234567890001', 1))).toBe('3201234567890001');
  });

  it('produces a different ciphertext every time for the same plaintext', () => {
    // The random nonce is what stops the column leaking equality. Two employees
    // with the same bank account must not be visibly the same at rest — that is
    // exactly the property ADR-0016 rejected deterministic encryption to keep,
    // and the blind index is the sanctioned exception.
    expect(seal(key, 'same', 1)).not.toBe(seal(key, 'same', 1));
  });

  it('stamps the DEK version the value was written under', () => {
    expect(versionOf(seal(key, 'x', 4))).toBe(4);
  });

  it('refuses a value with no version prefix', () => {
    expect(() => open(key, 'plaintext-nik')).toThrow(CipherFormatError);
    expect(() => versionOf('plaintext-nik')).toThrow(CipherFormatError);
  });

  it('refuses a truncated value', () => {
    expect(() => open(key, `v1:${Buffer.from('short').toString('base64')}`)).toThrow(
      CipherFormatError,
    );
  });

  it('refuses a tampered tag', () => {
    const sealed = seal(key, 'sensitive', 1);
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0xff, raw.length - 1);
    expect(() => open(key, `v1:${raw.toString('base64')}`)).toThrow();
  });

  it('refuses another tenant’s key', () => {
    // The blast-radius containment ADR-0016 decision 4 buys with per-tenant
    // DEKs: a row that crosses tenants carries nothing readable.
    expect(() => open(randomBytes(32), seal(key, 'sensitive', 1))).toThrow();
  });
});
