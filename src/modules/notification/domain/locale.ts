import type { Locale } from './notification.types';

/**
 * BR-NTF-006's resolution chain is *"user locale → tenant default → `id`"*, and
 * **the first two rungs have nothing to read** — so every V1 render is `id`, and
 * this constant is the whole of it (A-198).
 *
 * `users` (core-schema §4) has no locale column and settings §4.2 registers no
 * tenant-default locale key, so there is no source of truth to resolve against.
 * Locale is a client-side concern everywhere else it appears: admin-nextjs §11
 * keeps it in a cookie, mobile-flutter §1 in SharedPreferences, and
 * api-standards §3 scopes `Accept-Language` to *"server-generated documents
 * only"* — which a notification is not, and which would be unavailable anyway,
 * because BR-NTF-003 makes every send async and a job carries no request
 * headers.
 *
 * A constant rather than a `localeFor(userId)` seam with a discarded argument:
 * the day a stored locale exists, the grep is this name and there is exactly one
 * call site either way.
 */
export const DEFAULT_LOCALE: Locale = 'id';
