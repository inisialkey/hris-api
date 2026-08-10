import type { Locale } from './import-export.types';

/**
 * Every server-rendered artifact in this module is `id`, and the chain that
 * would decide otherwise has two empty rungs — A-198's finding, unchanged.
 *
 * UC-IMP-005 says a template carries *"localized headers (requester's locale)"*
 * and api-standards §3 scopes `Accept-Language` to server-generated documents,
 * which a template and an error workbook both are. But `users` (core-schema §4)
 * has no locale column and settings §4.2 registers no tenant-default locale key,
 * so a per-user or per-tenant answer does not exist to be read — and the two
 * artifacts that most need one, the error workbook and the export output, are
 * produced by a job with no request headers at all.
 *
 * Recorded rather than invented: adding a column to `users` is core-schema's
 * decision. When it lands, this constant is the one call site to change.
 */
export const DEFAULT_LOCALE: Locale = 'id';
