/** The one ambient credential (security-standards §5) — the web refresh cookie. */
export const REFRESH_COOKIE = 'hris_rt';

/**
 * Reads one cookie from a `Cookie` header. The platform's entire cookie
 * surface is the refresh token (security-standards §5), which is base64url —
 * no decoding beyond the URI unescape browsers may apply. Not a cookie-parser
 * replacement; it must never need to be one.
 */
export function readCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}
