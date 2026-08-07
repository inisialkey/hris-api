import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

/**
 * ADR-0016 decision 2's wire format, in one place because three things write it:
 * an encrypted column, a wrapped DEK, and a wrapped index key.
 *
 * `v<n>:` ‖ base64(nonce ‖ ciphertext ‖ tag), AES-256-GCM with a random 96-bit
 * nonce. The version prefix is not decoration — `tenant_keys.dek_version`
 * matches it, which is what lets a rotation job tell re-encrypted rows from
 * pending ones by reading the value rather than a side table.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = /^v(\d+):/;

export class CipherFormatError extends Error {}

export function seal(key: Buffer, plaintext: string, version: number): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v${String(version)}:${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64')}`;
}

export function versionOf(value: string): number {
  const matched = PREFIX.exec(value);
  if (!matched?.[1]) throw new CipherFormatError('ciphertext carries no version prefix');
  return Number(matched[1]);
}

/**
 * Throws on a wrong key, a truncated value, or a tampered tag — all three are
 * `SYS_INTERNAL` rather than a business failure, because none of them is
 * something a caller could have done differently (ADR-0006's throw/return line).
 */
export function open(key: Buffer, value: string): string {
  const matched = PREFIX.exec(value);
  if (!matched) throw new CipherFormatError('ciphertext carries no version prefix');

  const raw = Buffer.from(value.slice(matched[0].length), 'base64');
  if (raw.length <= NONCE_BYTES + TAG_BYTES) throw new CipherFormatError('ciphertext truncated');

  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
