import { Inject, Injectable } from '@nestjs/common';

import { currentRequestContext } from '../../../shared/context';
import type { EntityRef, FileOwner, FileRow } from '../../document';
import { listImportDefinitions } from '../domain/definitions';
import { EXPORT_JOB_ENTITY, IMPORT_JOB_ENTITY, USER_ENTITY } from '../domain/file-refs';
import {
  EXPORT_JOB_REPOSITORY,
  IMPORT_JOB_REPOSITORY,
  type ExportJobRepositoryPort,
  type ImportJobRepositoryPort,
} from '../domain/import-export.ports';
import { DefinitionAccessService } from './definition-access.service';

/** audit-log §4.3, registered by BR-IMP-010 (grilled 2026-08-02). */
const GATED_EXPORT_READ = 'document.download.gated_export';

/**
 * The `import_file` category's authorization half (document-storage §4.2), which
 * is BR-IMP-010's access rule and the reason that rule needed a resolver at all:
 * **one category, three different answers.**
 *
 * *"Import source files + error workbooks: any definition-permission holder.
 * Download an export output file: **requester only** (`created_by`)."*
 *
 * That asymmetry is the grilled decision of 2026-08-02 and it is deliberate: an
 * import artifact is a tenant record several people work on — §2 says any
 * definition-permission holder may confirm a job, and a confirmer who cannot
 * read the error workbook cannot decide anything — while an export output
 * *"embodies that requester's frozen entitlements"*. Two people holding the same
 * permission today may have held different ones at enqueue, so the bytes narrow
 * to one identity even though the job row stays tenant-visible under
 * `import-export.job.read`.
 *
 * Every predicate answers **false**, never an error (§4.2): a scope miss is a
 * 404 from the generic endpoint, which is what existence hiding requires.
 */
@Injectable()
export class ImportFileOwner implements FileOwner {
  readonly module = 'import-export';
  /**
   * Three, and the first is the odd one: UC-IMP-001 has the slot declare
   * `entityType user` / `entityId` = the uploader, because the job does not
   * exist when the upload starts. The re-parent moves it to `import_job` the
   * moment one does, which is why a `POST /imports` naming a file still parented
   * to a user is the normal case and one already parented to a job is a file
   * some other job owns.
   */
  readonly entityTypes = [USER_ENTITY, IMPORT_JOB_ENTITY, EXPORT_JOB_ENTITY] as const;

  constructor(
    @Inject(IMPORT_JOB_REPOSITORY) private readonly imports: ImportJobRepositoryPort,
    @Inject(EXPORT_JOB_REPOSITORY) private readonly exports: ExportJobRepositoryPort,
    private readonly access: DefinitionAccessService,
  ) {}

  /**
   * §4.2: *"write: any import definition permission (slot user-parented,
   * re-parented at job creation)"*.
   *
   * Only the slot path is writable. A worker writing an error workbook or an
   * export output does not come through here — UC-DOC-004 has no gate, because
   * there is no client on that path to gate.
   */
  async canWrite(ref: EntityRef): Promise<boolean> {
    if (ref.entityType !== USER_ENTITY) return false;
    // Somebody else's `entityId` would let a caller park a file under another
    // user and then claim it by id; the uploader is the only legal parent.
    if (ref.entityId !== currentRequestContext()?.userId) return false;

    const held = await this.access.heldPermissions();
    return listImportDefinitions().some((definition) => held.has(definition.requiredPermission));
  }

  async canRead(ref: EntityRef): Promise<boolean> {
    switch (ref.entityType) {
      case USER_ENTITY:
        return ref.entityId === currentRequestContext()?.userId;
      case IMPORT_JOB_ENTITY: {
        const job = await this.imports.findById(ref.entityId);
        return job ? this.access.holdsImportPermission(job.type) : false;
      }
      case EXPORT_JOB_ENTITY: {
        const job = await this.exports.findById(ref.entityId);
        // The whole of BR-IMP-010's narrowing, in one comparison. Not "holds the
        // export permission" — that would let a colleague download a file
        // containing the gated columns *they* were not entitled to when it was
        // frozen.
        return job ? job.requestedBy === currentRequestContext()?.userId : false;
      }
      default:
        return false;
    }
  }

  /**
   * §4.2 marks the category `clientDeletable: false` — *"job artifact"* — so the
   * platform half already refuses. This is the state half and it agrees: an
   * import's source workbook is the evidence of what was uploaded, and a purge
   * cron is what ends it (§12).
   */
  canDelete(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * BR-IMP-010: *"mints of outputs whose frozen column set includes gated
   * columns are audited sensitive reads (`document.download.gated_export`,
   * audit-log §4.3)"*.
   *
   * Per **file**, not per category — which is exactly why `FileOwner` carries
   * this hook rather than `CategoryPolicy`: whether an export carries a salary
   * or a NIK column is a property of the entitlement frozen into that one job,
   * and the same definition run by two people can produce one auditable file and
   * one ordinary one.
   */
  async sensitiveReadKey(file: FileRow): Promise<string | null> {
    if (file.entityType !== EXPORT_JOB_ENTITY) return null;
    const job = await this.exports.findById(file.entityId);
    return job?.params._gated ? GATED_EXPORT_READ : null;
  }
}
