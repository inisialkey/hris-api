/**
 * naming §11.4's path grammar and BR-DOC-012's tenant hygiene, in the one place
 * a path is ever built.
 *
 * *"storage paths are generated, never client-supplied or guessed"* (BR-DOC-001),
 * which is only true if there is nowhere else to build one. Every caller passes
 * the raw name; sanitation happens here rather than at the edge, so a second
 * entry point cannot skip it.
 */

/** §8's bound on `fileName`, applied after cleaning rather than before. */
const MAX_NAME = 255;

// eslint-disable-next-line no-control-regex -- removing them is the point
const NON_PRINTING = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex -- ditto, and these become a separator
const WHITESPACE_CONTROLS = /[\u0009-\u000d]+/g;

/**
 * §8: *"sanitation strips path separators/control chars (server-side, not a
 * rejection)"*. A user picked a file; the name is ours to make safe, not theirs
 * to get right.
 */
export function sanitizeFileName(raw: string): string {
  const cleaned = raw
    .replace(NON_PRINTING, '')
    // A tab or a newline inside a name was a separator to whoever typed it.
    .replace(WHITESPACE_CONTROLS, '_')
    .replace(/[/\\:]+/g, '_')
    // `..` survives the separator pass as a component of its own, and it is the
    // traversal token itself that has to go.
    .replace(/\.{2,}/g, '')
    .replace(/_+/g, '_')
    .replace(/ {2,}/g, ' ')
    .replace(/^[._\s]+/, '')
    .replace(/[._\s]+$/, '');

  return (cleaned === '' ? 'file' : cleaned).slice(0, MAX_NAME);
}

/** `tenants/{tenantId}/{ns}/{entityId}/{fileId}_{sanitizedOriginalName}`. */
export function finalPath(
  tenantId: string,
  ns: string,
  entityId: string,
  fileId: string,
  originalName: string,
): string {
  return `tenants/${tenantId}/${ns}/${entityId}/${fileId}_${sanitizeFileName(originalName)}`;
}

/**
 * The staging prefix ADR-0009 gives a 24 h lifecycle rule. A staged object
 * written anywhere else would never auto-delete, and BR-DOC-003's *"never
 * trusted, never committed"* would leave bytes behind forever.
 */
export function stagingPath(
  tenantId: string,
  ns: string,
  entityId: string,
  fileId: string,
  originalName: string,
): string {
  return `uploads/${tenantId}/${ns}/${entityId}/${fileId}_${sanitizeFileName(originalName)}`;
}
