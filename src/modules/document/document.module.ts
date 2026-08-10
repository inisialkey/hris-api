import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuditModule } from '../audit';
import { SettingsModule } from '../settings';
import { FileAccessService } from './application/access.service';
import { DeleteFileUseCase } from './application/delete.use-case';
import { DocumentJobsService } from './application/document-jobs.service';
import { DownloadUseCase } from './application/download.use-case';
import { FileQueryService } from './application/file-query.service';
import { GeneratedFileService } from './application/generated-file.service';
import { StorageUsageService } from './application/storage-usage.service';
import { UploadUseCase } from './application/upload.use-case';
import { documentErrorStatus } from './domain/document.errors';
import {
  DOCUMENT_OUTBOX,
  DOCUMENT_PORT,
  FILE_REPOSITORY,
  STORAGE_PORT,
  STORAGE_USAGE_PORT,
} from './domain/document.ports';
import { FileRepository } from './infrastructure/file.repository';
import { GcsStorage } from './infrastructure/gcs.storage';
import { DocumentsController } from './presentation/documents.controller';

registerErrorStatuses(documentErrorStatus);

/**
 * Spine order 5.
 *
 * **No `registerAuditedTables` call, and that is the decision rather than the
 * omission.** `files` has no audit-log §4.2 row: the two facts audit wants from
 * this table are `document.file.committed` and `document.file.deleted`, both
 * already on §12's consumed list, and a channel-1 diff would file them twice and
 * add a row for every `expiry_reminded_at` stamp the scan writes.
 *
 * The module ships with **one owner registered** — employee's, the only owning
 * module that exists. The other nine §4.2 categories carry their full policy and
 * no owner, which is exactly what "not live" means here: a slot request for one
 * is a 404, not an unguarded upload. That is the same line approval drew when it
 * shipped a complete port with no consumer, arrived at from the other side —
 * the *policy* is fully defined by §4.2 and by nothing a caller decides, while
 * the *gate* is defined by nothing but the caller.
 *
 * `DocumentJobsService` has no schedule for the reason the approval SLA scan and
 * the audit anchor have none: ADR-0010 puts crons on BullMQ and there is no
 * worker in this repository yet.
 */
@Module({
  imports: [AuditModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [
    FileAccessService,
    UploadUseCase,
    DownloadUseCase,
    FileQueryService,
    DeleteFileUseCase,
    DocumentJobsService,
    StorageUsageService,
    GeneratedFileService,

    { provide: FILE_REPOSITORY, useClass: FileRepository },
    { provide: STORAGE_PORT, useClass: GcsStorage },
    { provide: DOCUMENT_OUTBOX, useExisting: OutboxRepository },
    { provide: STORAGE_USAGE_PORT, useExisting: StorageUsageService },
    { provide: DOCUMENT_PORT, useExisting: GeneratedFileService },
  ],
  exports: [STORAGE_USAGE_PORT, DOCUMENT_PORT],
})
export class DocumentModule {}
