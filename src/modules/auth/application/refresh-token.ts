import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque 256-bit random, never a JWT: ADR-0004 needs revocation and a session
 * list, and a stateless refresh token cannot be killed. Only the SHA-256 ever
 * reaches a store — a dump of `sessions` is not a set of live credentials.
 */
export function mintRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Also the reset/invite token hash (BR-AUTH-010: sha256 stored). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
