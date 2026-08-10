/**
 * The sheet names and marker labels the reader and the writer must agree on.
 *
 * One file rather than two copies, because a template written with one spelling
 * and read with another is BR-IMP-006's stale-template error raised against
 * every file the product ever generated — the failure would look exactly like
 * the one the marker exists to report.
 */

/** BR-IMP-006's marker sheet, written first so a stale file fails before its rows are read. */
export const META_SHEET = '_meta';

/** UC-IMP-005's *"hidden enum sheet"* — the allowed values, per enum column. */
export const ENUM_SHEET = '_enums';

export const DATA_SHEET = 'Data';

export const TEMPLATE_VERSION_LABEL = 'templateVersion';
export const DEFINITION_KEY_LABEL = 'definition';

/** The MIME the `import_file` category whitelists (document-storage §4.2). */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
