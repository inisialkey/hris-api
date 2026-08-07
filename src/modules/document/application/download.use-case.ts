import { Inject, Injectable, Logger } from '@nestjs/common';

import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { AUDIT_PORT, type AuditPort } from '../../audit';
import {
  FILE_REPOSITORY,
  STORAGE_PORT,
  type FileRepositoryPort,
  type StoragePort,
} from '../domain/document.ports';
import type { SignedDownload } from '../domain/document.types';
import { FileAccessService } from './access.service';

/**
 * UC-DOC-003 — the mint, and the only enforcement point in the read path.
 *
 * *"Client may re-request freely (each mint re-checks authorization — permission
 * revocation bites at the next mint, not mid-URL)"*. That is why the list
 * endpoint is advisory and this one is not: a metadata row a caller can still
 * see is navigation, and the URL is the access.
 */
@Injectable()
export class DownloadUseCase {
  private readonly logger = new Logger(DownloadUseCase.name);

  constructor(
    @Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
    private readonly access: FileAccessService,
  ) {}

  async mint(fileId: string): Promise<Result<SignedDownload>> {
    const file = await this.repository.findById(fileId);
    // §7: *"Staged/deleted/scope-miss → 404"*. A staged row is an upload in
    // flight, not a document — BR-DOC-001.
    if (!file || file.status !== 'committed') return fail(sharedErrors.notFound());

    const gate = await this.access.forRead(file);
    if (!gate.ok) return gate;
    const category = gate.value;

    // §9: *"Object missing for a committed row (manual bucket surgery): download
    // mint verifies object existence lazily → row flagged, Sentry event,
    // SYS_INTERNAL to client — inconsistency is loud, never silent"*. The flag is
    // this log line: `commit_failure_code` is documented as staged-rows-only and
    // writing it here would put a commit failure on a file that committed fine.
    if (!(await this.storage.exists(file.storagePath))) {
      this.logger.error(
        `committed file ${file.id} has no object at its storage path — bucket and metadata disagree`,
      );
      return fail(sharedErrors.internal());
    }

    // §12, **fail-closed** (audit-log UC-AUD-003): the insert precedes the URL,
    // and an insert failure aborts the mint. A read audit that can be dropped is
    // not an access record.
    const readKey =
      category.sensitiveReadKey ?? (await category.owner.sensitiveReadKey?.(file)) ?? null;
    if (readKey) {
      await this.audit.sensitiveRead(readKey, 'file', file.id, {
        category: file.category,
        entityType: file.entityType,
        entityId: file.entityId,
      });
    }

    const signed = await this.storage.signDownload(
      file.storagePath,
      category.downloadUrlTtlSeconds,
    );
    return ok({ url: signed.url, expiresAt: signed.expiresAt });
  }
}
