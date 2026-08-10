/**
 * The three entity types this module parks files under, and the one category it
 * uses. One file because the owner predicate, the job services, and the tests
 * all have to agree — a re-parent writing `import-job` while the resolver reads
 * `import_job` is a file nobody can download and nothing that fails loudly.
 */

import type { EntityRef } from '../../document';

/** document-storage §4.2's key: xlsx, 20 MB, no client delete, job artifact. */
export const IMPORT_FILE_CATEGORY = 'import_file';

/**
 * UC-IMP-001's slot parent. *"The slot declares entityType `user` / entityId =
 * the uploader — the job doesn't exist yet."* The re-parent moves it off this
 * the moment one does.
 */
export const USER_ENTITY = 'user';
export const IMPORT_JOB_ENTITY = 'import_job';
export const EXPORT_JOB_ENTITY = 'export_job';

export function jobEntityRef(importJobId: string): EntityRef {
  return { entityType: IMPORT_JOB_ENTITY, entityId: importJobId };
}

export function exportEntityRef(exportJobId: string): EntityRef {
  return { entityType: EXPORT_JOB_ENTITY, entityId: exportJobId };
}
