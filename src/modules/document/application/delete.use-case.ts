import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { documentErrors } from '../domain/document.errors';
import {
  DOCUMENT_OUTBOX,
  FILE_REPOSITORY,
  type DocumentOutboxPort,
  type FileRepositoryPort,
} from '../domain/document.ports';
import { FileAccessService } from './access.service';

/**
 * UC-DOC-005 — soft delete only. The object outlives the row until
 * `cron.document.purge` runs, because BR-DOC-009's order is object-then-row in
 * one direction and a delete that removed the object first could fail halfway
 * and leave a committed row pointing at nothing.
 */
@Injectable()
export class DeleteFileUseCase {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort,
    @Inject(DOCUMENT_OUTBOX) private readonly outbox: DocumentOutboxPort,
    private readonly access: FileAccessService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async remove(fileId: string): Promise<Result<{ id: string }>> {
    const file = await this.repository.findById(fileId);
    if (!file) return fail(sharedErrors.notFound());

    // Visibility first, then the category's own refusal, then the owner's.
    // Both `DOC_DELETE_FORBIDDEN` and 404 have to stay reachable: a caller who
    // can see the file deserves to be told it is retained, and a caller who
    // cannot see it must learn nothing — including that it is retained.
    const visible = await this.access.forRead(file);
    if (!visible.ok) return visible;

    if (!visible.value.clientDeletable) {
      return fail(documentErrors.deleteForbidden({ category: file.category }));
    }

    const gate = await this.access.forDelete(file);
    if (!gate.ok) return gate;

    const deleted = await this.repository.softDelete(
      file.id,
      this.clock.now(),
      currentRequestContext()?.userId,
    );
    if (!deleted) return fail(sharedErrors.notFound());

    await this.outbox.emit({
      name: 'document.file.deleted',
      tenantId: requireTenantContext().tenantId,
      aggregateId: deleted.id,
      payload: { fileId: deleted.id, category: deleted.category },
    });
    return ok({ id: deleted.id });
  }
}
