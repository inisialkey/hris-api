import { Module, type OnModuleInit } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuthzModule } from '../authz';
import { DocumentModule, registerFileOwner } from '../document';
import { NotificationModule } from '../notification';
import { SettingsModule } from '../settings';
import { CommitImportService } from './application/commit-import.service';
import { DefinitionAccessService } from './application/definition-access.service';
import { DefinitionQueryService } from './application/definition-query.service';
import { ExportService } from './application/export.service';
import { ImportExportJobsService } from './application/import-export-jobs.service';
import { ImportFileOwner } from './application/import-file.owner';
import { ImportJobsService } from './application/import-jobs.service';
import { RowValidationService } from './application/row-validation.service';
import { ValidateImportService } from './application/validate-import.service';
import { IMPORT_FILE_CATEGORY } from './domain/file-refs';
import { importExportErrorStatus } from './domain/import-export.errors';
import {
  EXPORT_JOB_REPOSITORY,
  IMPORT_EXPORT_OUTBOX,
  IMPORT_JOB_REPOSITORY,
  WORKBOOK_READER,
  WORKBOOK_WRITER,
} from './domain/import-export.ports';
import { ExportJobRepository } from './infrastructure/export-job.repository';
import { ImportJobRepository } from './infrastructure/import-job.repository';
import { XlsxWorkbookReader } from './infrastructure/xlsx.reader';
import { XlsxWorkbookWriter } from './infrastructure/xlsx.writer';
import { ImportExportController } from './presentation/import-export.controller';

registerErrorStatuses(importExportErrorStatus);

/**
 * Spine order 7 — the last of the backbone.
 *
 * **This module ships the framework and zero definitions, and that is the
 * decision rather than an omission.** BR-IMP-001 is the platform law: *"modules
 * register `ImportDefinition`/`ExportDefinition` in code + their doc §13 + this
 * doc's §4.3 table, same session. No tenant-built mappings."* §4.3's thirty rows
 * belong to twenty modules; each one carries a permission key, a natural key and
 * a `rowHandler` that only its owner can write. Registering them from here would
 * be this module deciding what a row of somebody else's data means.
 *
 * It is document-storage's shape exactly: nine of its ten categories ship
 * policy-complete and ownerless, and an unowned category is **not live**. Here a
 * key with nothing registered against it is likewise not live — `POST /imports`
 * for it is `VAL_INVALID_ENUM` and `GET /definitions` does not list it. That is
 * what makes registration the gate rather than a decoration (A-200).
 *
 * **`ApprovalModule` is deliberately absent.** §13: *"Approval: none — imports
 * are permission-gated direct writes; definitions whose domain requires approval
 * semantics must model that in their row handler's module."*
 *
 * **No `registerAuditedTables` call**, so neither repository extends
 * `TenantScopedRepository`: `import_jobs` and `export_jobs` have no audit-log
 * §4.2 row, and §12's two events are already on audit's consumed list. A
 * channel-1 diff of a job row would file "a job changed status" beside the
 * writes it made, which are audited in the modules that made them.
 *
 * The three processors and the two crons ship as **bodies with no scheduler**,
 * for the reason every job in this repository does: ADR-0010 dispatches from a
 * BullMQ worker that does not exist here.
 */
@Module({
  imports: [AuthzModule, DocumentModule, NotificationModule, SettingsModule],
  controllers: [ImportExportController],
  providers: [
    DefinitionAccessService,
    DefinitionQueryService,
    RowValidationService,
    ImportJobsService,
    ValidateImportService,
    CommitImportService,
    ExportService,
    ImportExportJobsService,
    ImportFileOwner,

    { provide: IMPORT_JOB_REPOSITORY, useClass: ImportJobRepository },
    { provide: EXPORT_JOB_REPOSITORY, useClass: ExportJobRepository },
    { provide: WORKBOOK_READER, useClass: XlsxWorkbookReader },
    { provide: WORKBOOK_WRITER, useClass: XlsxWorkbookWriter },
    { provide: IMPORT_EXPORT_OUTBOX, useExisting: OutboxRepository },
  ],
  exports: [],
})
export class ImportExportModule implements OnModuleInit {
  constructor(private readonly files: ImportFileOwner) {}

  /**
   * document-storage §4.2's binding. `onModuleInit` rather than file load,
   * because the owner is a provider with three injected dependencies and the
   * registry wants the instance the container built (employee's precedent).
   */
  onModuleInit(): void {
    registerFileOwner(IMPORT_FILE_CATEGORY, this.files);
  }
}
