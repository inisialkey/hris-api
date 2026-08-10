import type { Locale } from './inbox.types';

/**
 * BR-INB-005 renders *"in the recipient's locale"* and cites notification
 * BR-NTF-006's pattern, which is exactly the pattern A-198 found had nowhere to
 * read a locale from. Nothing has changed since: `users` (core-schema §4) has no
 * locale column, settings §4.2 registers no tenant-default locale key, and
 * api-standards §3 scopes `Accept-Language` to server-generated documents — and
 * an item materialized by an event handler has no request to read a header from
 * even if it were in scope.
 *
 * So every V1 render is `id`, and both locales still ship in `titles.ts`: the
 * missing rung is the *lookup*, not the copy, and a registry with one locale in
 * it would make the gap invisible on the day a locale column lands.
 */
export const DEFAULT_LOCALE: Locale = 'id';
