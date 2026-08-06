import type { ErrorDetailEntry } from '../../../shared/envelope';
import { authFieldCodes } from './auth.errors';

/**
 * The tenant password policy (security-standards §2), as a pure function.
 *
 * Transport already enforces 10–128 in the DTOs; this re-checks length so the
 * policy is complete when called from anywhere, then applies the two rules the
 * transport layer cannot: the breached-list and derived-string denials. Entries
 * use policy-rule field codes (error-catalog: "policy rules as field-level
 * codes"), never a message — the client renders `errors.<code>`.
 *
 * The platform floor is 10; `auth.password_min_length` may only tighten above
 * it (settings.md, BR-SET-008) and arrives with the settings module.
 */
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

// ponytail: an embedded top-slice of breached passwords that clear the 10-char
// floor — the full breached-corpus check lands with the settings module, where
// the policy becomes tenant-tunable. Lowercase; matching is case-insensitive.
const BREACHED = new Set([
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'q1w2e3r4t5y6',
  '1q2w3e4r5t6y',
  'password123',
  'password1234',
  'passw0rd123',
  'admin123456',
  'administrator',
  'iloveyou123',
  'welcome123',
  'football123',
  'monkey123456',
  'dragon123456',
  'sunshine123',
  'princess123',
  'qwerty123456',
  'abcd1234567',
  '1234qwer5678',
  'indonesia123',
  'jakarta12345',
]);

export interface PasswordPolicyContext {
  /** Lowercased account email; its local part is a denied substring. */
  email?: string;
  /** Tenant display name, when the caller already holds it. */
  tenantName?: string;
}

function field(code: string, params?: Record<string, unknown>): ErrorDetailEntry {
  return { field: 'newPassword', code, messageKey: `errors.${code}`, params };
}

/** Empty array = the password passes. Never throws. */
export function checkPasswordPolicy(
  password: string,
  context: PasswordPolicyContext = {},
): ErrorDetailEntry[] {
  const entries: ErrorDetailEntry[] = [];

  if (password.length < MIN_LENGTH) {
    entries.push(field(authFieldCodes.tooShort, { min: MIN_LENGTH }));
    // A short password needs no further verdicts — one actionable entry beats
    // three about a value the user is already retyping.
    return entries;
  }
  if (password.length > MAX_LENGTH) {
    return [field(authFieldCodes.tooLong, { max: MAX_LENGTH })];
  }

  const lowered = password.toLowerCase();

  if (BREACHED.has(lowered)) {
    entries.push(field(authFieldCodes.breached));
  }

  // Derived-string denial: the email local part and the tenant name must not
  // appear inside the password. Fragments shorter than 4 are skipped — "a@x.co"
  // would otherwise deny every password containing the letter a.
  const fragments: string[] = [];
  if (context.email) {
    const local = context.email.toLowerCase().split('@')[0] ?? '';
    if (local.length >= 4) fragments.push(local);
  }
  if (context.tenantName && context.tenantName.length >= 4) {
    fragments.push(context.tenantName.toLowerCase());
  }
  if (fragments.some((fragment) => lowered.includes(fragment))) {
    entries.push(field(authFieldCodes.derived));
  }

  return entries;
}
