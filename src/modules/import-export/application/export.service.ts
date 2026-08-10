import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { DOCUMENT_PORT, type DocumentPort } from '../../document';
import { NOTIFICATION_PORT, type NotificationPort } from '../../notification';
import {
  entitledColumns,
  findExportDefinition,
  type ExportDefinition,
  type ResolvedExport,
} from '../domain/definitions';
import { exportEntityRef, IMPORT_FILE_CATEGORY } from '../domain/file-refs';
import {
  EXPORT_JOB_REPOSITORY,
  IMPORT_EXPORT_OUTBOX,
  WORKBOOK_WRITER,
  type ExportJobRepositoryPort,
  type ImportExportOutboxPort,
  type WorkbookWriterPort,
} from '../domain/import-export.ports';
import type {
  ExportJobParams,
  ExportJobRow,
  ExportParams,
  Page,
  Paged,
} from '../domain/import-export.types';
import { DEFAULT_LOCALE } from '../domain/locale';
import { failureCodes } from '../domain/import-export.errors';
import { validateParams } from '../domain/params';
import { XLSX_MIME } from '../infrastructure/workbook-layout';
import { DefinitionAccessService } from './definition-access.service';

/**
 * UC-IMP-006, both halves — the enqueue on the request path and the
 * `export.generate:jobId` body.
 *
 * BR-IMP-010 governs the whole of it and has three separate clauses that all
 * land here: the column entitlement is **frozen at enqueue** from the
 * requester's own permissions, every written cell is injection-guarded (in the
 * writer), and the output is downloadable by the requester alone — which is the
 * `import_file` owner's job and is why `created_by` on the job row is load-
 * bearing rather than bookkeeping.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @Inject(EXPORT_JOB_REPOSITORY) private readonly jobs: ExportJobRepositoryPort,
    @Inject(DOCUMENT_PORT) private readonly documents: DocumentPort,
    @Inject(WORKBOOK_WRITER) private readonly writer: WorkbookWriterPort,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(IMPORT_EXPORT_OUTBOX) private readonly outbox: ImportExportOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: DefinitionAccessService,
  ) {}

  /**
   * *"definition + permission check, params validated against `ParamSpec`, job
   * `queued` → `export.generate:jobId`"*.
   *
   * The entitlement freeze happens **here**, before the job exists, which is
   * what makes §9's revoked-permission case answerable: *"the file matches what
   * they were entitled to when they asked"*. Resolving it in the generator
   * instead would produce a narrower file than the job promised, silently.
   */
  async enqueue(type: string, raw: Record<string, unknown>): Promise<Result<ExportJobRow>> {
    const found = await this.access.exportFor(type);
    if (!found.ok) return found;
    const definition = found.value;

    const params = validateParams(definition.params, raw);
    if (!params.ok) return params;

    // §4.3's definition-resolved amendment: permission, columns and query port
    // may come from a consumer registry keyed by one of the definition's own
    // params, and the resolution happens *"at enqueue, before the permission
    // check and before BR-IMP-010's entitlement freeze"* — which is this order.
    const resolved = await resolve(definition, params.value);
    if (resolved.requiredPermission !== definition.requiredPermission) {
      const held = await this.access.heldPermissions();
      if (!held.has(resolved.requiredPermission)) return fail(sharedErrors.notFound());
    }

    const held = await this.access.heldPermissions();
    const entitlement = entitledColumns(resolved.columnSets, held);

    const stored: ExportJobParams = {
      ...params.value,
      _columns: entitlement.columns.map((column) => column.key),
      _gated: entitlement.gated,
    };
    return ok(await this.jobs.insert(type, stored));
  }

  async find(id: string): Promise<Result<ExportJobRow>> {
    const job = await this.jobs.findById(id);
    return job ? ok(job) : fail(sharedErrors.notFound());
  }

  async list(
    filter: { type?: string; status?: ExportJobRow['status'] },
    page: Page,
  ): Promise<Paged<ExportJobRow>> {
    return this.jobs.list(filter, page);
  }

  /**
   * The `export.generate:jobId` body — *"streaming query port → streaming writer
   * → file committed via worker path (document-storage UC-DOC-004) → `completed`
   * + notification with the job link"*.
   *
   * **No schedule** (ADR-0010, no worker here). Idempotent by state: a
   * redelivery finds the job `completed` and returns it, because generating the
   * file twice would leave the first output orphaned in the bucket with a row
   * pointing at the second.
   */
  async generate(jobId: string): Promise<Result<ExportJobRow>> {
    const job = await this.jobs.findById(jobId);
    if (!job) return fail(sharedErrors.notFound());
    if (job.status === 'completed') return ok(job);

    const definition = findExportDefinition(job.type);
    if (!definition) return this.markFailed(job, failureCodes.internal);

    await this.jobs.update(job.id, { status: 'running' });

    // `_gated` is the owner's business at download time, not the writer's here.
    const { _columns, _gated: _entitlementFlag, ...filters } = job.params;
    const resolved = await resolve(definition, filters as ExportParams);
    // The frozen keys decide the file's shape; the definition decides each
    // column's header. A column that vanished from the definition between
    // enqueue and generation is dropped rather than emitted empty — the file
    // then matches the definition it was written from.
    const declared = [
      ...resolved.columnSets.base,
      ...(resolved.columnSets.gated ?? []).flatMap((set) => set.columns),
    ];
    const columns = _columns
      .map((key) => declared.find((column) => column.key === key))
      .filter((column): column is (typeof declared)[number] => column !== undefined);

    let rowCount = 0;
    try {
      const file = await this.documents.storeGenerated(
        {
          category: IMPORT_FILE_CATEGORY,
          ...exportEntityRef(job.id),
          fileName: `${definition.key}.xlsx`,
          mime: XLSX_MIME,
        },
        async (sink) => {
          rowCount = await this.writer.exportRows(
            {
              definition,
              locale: DEFAULT_LOCALE,
              columns,
              params: filters as ExportParams,
              stream: resolved.queryPort.stream(filters as ExportParams),
            },
            sink,
          );
        },
      );

      const completed = await this.jobs.update(job.id, {
        status: 'completed',
        fileId: file.id,
        rowCount,
        completedAt: this.clock.now(),
      });
      if (!completed) return fail(sharedErrors.notFound());

      await this.notify(completed);
      await this.outbox.emit({
        name: 'import-export.export.completed',
        tenantId: requireTenantContext().tenantId,
        aggregateId: completed.id,
        payload: { jobId: completed.id, type: completed.type, rowCount },
      });
      return ok(completed);
    } catch (error) {
      this.logger.error(`export job ${job.id} (${job.type}) failed: ${String(error)}`);
      return this.markFailed(job, failureCodes.internal);
    }
  }

  /**
   * §13: *"audience: requester only — the sole identity that can download the
   * output, BR-IMP-010"*. The template links the **job page**, not a URL — §5's
   * *"URL minted at click, not embedded — TTL hygiene"*, since a 10-minute
   * signed link in an inbox item is dead by the time anyone reads it.
   */
  private async notify(job: ExportJobRow): Promise<void> {
    if (!job.requestedBy) return;
    await this.notifications.send({
      templateKey: 'import-export.export_finished',
      recipients: { kind: 'users', userIds: [job.requestedBy] },
      params: { exportType: job.type },
      dedupeKey: `import-export.export_finished:${job.id}`,
    });
  }

  private async markFailed(job: ExportJobRow, code: string): Promise<Result<ExportJobRow>> {
    const updated = await this.jobs.update(job.id, {
      status: 'failed',
      failureCode: code,
      completedAt: this.clock.now(),
    });
    return updated ? ok(updated) : fail(sharedErrors.notFound());
  }
}

async function resolve(
  definition: ExportDefinition,
  params: ExportParams,
): Promise<ResolvedExport> {
  return definition.resolve
    ? definition.resolve(params)
    : {
        requiredPermission: definition.requiredPermission,
        columnSets: definition.columnSets,
        queryPort: definition.queryPort,
      };
}
