import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { DOCUMENT_PORT, type DocumentPort } from '../../document';
import { IMPORT_FILE_CATEGORY, jobEntityRef } from '../domain/file-refs';
import { importExportErrors } from '../domain/import-export.errors';
import {
  IMPORT_JOB_REPOSITORY,
  type ImportJobFilter,
  type ImportJobRepositoryPort,
} from '../domain/import-export.ports';
import type { ImportJobRow, Page, Paged } from '../domain/import-export.types';
import { DefinitionAccessService } from './definition-access.service';

/**
 * UC-IMP-001, UC-IMP-003's first half, and UC-IMP-004 — everything an import job
 * does on the **request** path. The two long-running halves (dry-run and commit)
 * are job bodies and live in their own services.
 *
 * `enqueue` does not appear anywhere below, and that is the same absence every
 * other module in this repository carries: ADR-0010 dispatches `import.validate`
 * and `import.commit` from a BullMQ worker that does not exist here. What ships
 * is the state each endpoint leaves the row in, which is precisely what those
 * processors read.
 */
@Injectable()
export class ImportJobsService {
  constructor(
    @Inject(IMPORT_JOB_REPOSITORY) private readonly jobs: ImportJobRepositoryPort,
    @Inject(DOCUMENT_PORT) private readonly documents: DocumentPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: DefinitionAccessService,
  ) {}

  /**
   * UC-IMP-001 — *"definition + permission check, file check (committed
   * `import_file`, `uploaded_by` = caller, still user-parented), concurrency
   * guard (unique partial index — race-safe), job `uploaded` + file re-parented
   * to the job in the same tx"*.
   *
   * The stated tradeoff, unchanged: `IMP_ALREADY_RUNNING` surfaces *after* the
   * upload, because the guard needs a `fileId` to insert with. Collisions are
   * rare and the alternative — reserving the slot before the file exists — puts
   * a lock in front of every upload to protect against a race two people have
   * to arrange.
   */
  async start(type: string, fileId: string): Promise<Result<ImportJobRow>> {
    const definition = await this.access.importFor(type);
    if (!definition.ok) return definition;

    const file = await this.documents.find(fileId);
    // Every miss is a 404 and none of them says which: another uploader's file,
    // a receipt, a slot never confirmed, a file already claimed by an earlier
    // job. §14 asserts the foreign-`fileId` case specifically.
    if (
      !file ||
      file.category !== IMPORT_FILE_CATEGORY ||
      file.uploadedBy !== currentRequestContext()?.userId ||
      file.entityType !== 'user'
    ) {
      return fail(sharedErrors.notFound());
    }

    const job = await this.jobs.insertIfNoneActive(type, fileId);
    if (!job) {
      const active = await this.jobs.findActive(type);
      // The winner must exist — the index just refused this insert because of it
      // — but a row that vanished between the two statements is a 409 with
      // nothing to point at rather than a crash.
      return active
        ? fail(importExportErrors.alreadyRunning({ activeJobId: active.id }))
        : fail(sharedErrors.internal());
    }

    // *"…in the same tx"*: the request's own transaction, so a failure past this
    // point leaves neither a job with a file it does not own nor a file parented
    // to a job that was rolled back.
    await this.documents.reparent(fileId, jobEntityRef(job.id));
    return ok(job);
  }

  async find(id: string): Promise<Result<ImportJobRow>> {
    const job = await this.jobs.findById(id);
    return job ? ok(job) : fail(sharedErrors.notFound());
  }

  async list(filter: ImportJobFilter, page: Page): Promise<Paged<ImportJobRow>> {
    return this.jobs.list(filter, page);
  }

  /**
   * UC-IMP-003's request half — *"status guard (`IMP_INVALID_STATE`) →
   * `committing` → `import.commit:jobId`"*.
   *
   * §2: *"any definition-permission holder may confirm — jobs are tenant
   * artifacts, not personal drafts"*. So the gate is the definition's permission
   * and explicitly **not** being the requester: an admin who uploaded a file on
   * Friday must not be the only person who can finish it.
   */
  async confirm(id: string): Promise<Result<ImportJobRow>> {
    const guarded = await this.guard(id);
    if (!guarded.ok) return guarded;

    const confirmed = await this.jobs.confirmIfAwaiting(
      id,
      currentRequestContext()?.userId,
      this.clock.now(),
    );
    // Lost the race: somebody else's confirm or the auto-cancel landed between
    // the read and the update. Re-reading is what lets the answer name the state
    // the caller actually lost to.
    return confirmed ? ok(confirmed) : this.lostRace(id);
  }

  /**
   * UC-IMP-004 — *"from `awaiting_confirmation` only (validating is short-lived;
   * committing is not abortable mid-batch in V1)"*.
   */
  async cancel(id: string): Promise<Result<ImportJobRow>> {
    const guarded = await this.guard(id);
    if (!guarded.ok) return guarded;

    const cancelled = await this.jobs.cancelIfAwaiting(id, this.clock.now());
    if (!cancelled) return this.lostRace(id);
    return this.find(id);
  }

  private async guard(id: string): Promise<Result<ImportJobRow>> {
    const found = await this.find(id);
    if (!found.ok) return found;

    const definition = await this.access.importFor(found.value.type);
    if (!definition.ok) return definition;

    return found.value.status === 'awaiting_confirmation'
      ? found
      : fail(importExportErrors.invalidState({ status: found.value.status }));
  }

  private async lostRace(id: string): Promise<Result<ImportJobRow>> {
    const current = await this.jobs.findById(id);
    return current
      ? fail(importExportErrors.invalidState({ status: current.status }))
      : fail(sharedErrors.notFound());
  }
}
