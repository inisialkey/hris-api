import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { DOCUMENT_PORT, type DocumentPort } from '../../document';
import { NOTIFICATION_PORT, type NotificationPort } from '../../notification';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import {
  EXPORT_JOB_REPOSITORY,
  IMPORT_JOB_REPOSITORY,
  type ExportJobRepositoryPort,
  type ImportJobRepositoryPort,
} from '../domain/import-export.ports';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** BR-IMP-011 — *"auto-cancels after 24 h (platform-fixed)"*, so not a setting. */
const CONFIRMATION_WINDOW_HOURS = 24;

/** settings §4.2, default 365 — the operational class of database-conventions §4.4. */
const RETENTION_KEY = 'import-export.retention_days';

const BATCH = 500;

export interface AutoCancelReport {
  cancelled: number;
  raced: number;
}

export interface PurgeReport {
  importJobs: number;
  exportJobs: number;
  files: number;
}

/**
 * §12's two crons, as bodies.
 *
 * **No schedule**, for the reason the approval SLA scan, the audit anchor, the
 * document sweeps, the notification purge and the inbox purge have none:
 * ADR-0010 puts crons on BullMQ and this repository has no worker. The body is
 * the part that has to be right.
 */
@Injectable()
export class ImportExportJobsService {
  private readonly logger = new Logger(ImportExportJobsService.name);

  constructor(
    @Inject(IMPORT_JOB_REPOSITORY) private readonly imports: ImportJobRepositoryPort,
    @Inject(EXPORT_JOB_REPOSITORY) private readonly exports: ExportJobRepositoryPort,
    @Inject(DOCUMENT_PORT) private readonly documents: DocumentPort,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `cron.import-export.auto-cancel` — BR-IMP-011.
   *
   * *"Stale dry-runs must not be committable days later against drifted data"*,
   * which is BR-IMP-002's premise enforced rather than trusted: commit
   * revalidation catches drift, and this bounds how much drift there can be.
   *
   * The transition is guarded, so a confirm landing in the same second wins and
   * is counted as a race rather than overwritten — the job is then `committing`
   * and cancelling it would strand a commit mid-batch.
   */
  async autoCancelStale(): Promise<AutoCancelReport> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - CONFIRMATION_WINDOW_HOURS * HOUR_MS);
    const report: AutoCancelReport = { cancelled: 0, raced: 0 };

    for (const job of await this.imports.staleAwaitingConfirmation(cutoff, BATCH)) {
      if (!(await this.imports.cancelIfAwaiting(job.id, now))) {
        report.raced += 1;
        continue;
      }
      report.cancelled += 1;

      // §13 lists auto-cancellation among the terminal states that notify. The
      // requester uploaded a file, walked away, and needs to know it expired
      // rather than finding a `cancelled` row a week later.
      if (job.requestedBy) {
        await this.notifications.send({
          templateKey: 'import-export.import_finished',
          recipients: { kind: 'users', userIds: [job.requestedBy] },
          params: { importType: job.type, applied: 0, failed: job.errorRows ?? 0 },
          dedupeKey: `import-export.import_finished:${job.id}`,
        });
      }
    }
    return report;
  }

  /**
   * `cron.import-export.purge` — *"hard-deletes terminal job rows + their stored
   * files (source, error workbooks, outputs — via document-storage) older than
   * `import-export.retention_days`"*.
   *
   * **Files are soft-deleted, not removed.** `import_file` carries
   * `retention: none` in document-storage §4.2, which means a soft-deleted row
   * is collected by `cron.document.purge` on its next run, object then row
   * (BR-DOC-009). Deleting the object from here would be a second code path to
   * the bucket, and the one that does not know about the object-then-row
   * ordering that keeps orphans impossible.
   *
   * Two-sided by construction (testing-strategy §14.1's destructive-cron rule):
   * the predicate is terminal **and** older than the cutoff, so a job that is
   * merely old and still awaiting confirmation is BR-IMP-011's business and not
   * this job's.
   */
  async purge(): Promise<PurgeReport> {
    const days = await this.settings.resolve<number>(RETENTION_KEY);
    const cutoff = new Date(this.clock.now().getTime() - days * DAY_MS);
    const report: PurgeReport = { importJobs: 0, exportJobs: 0, files: 0 };

    for (const job of await this.imports.terminalCreatedBefore(cutoff, BATCH)) {
      // Source first, then the error workbook: the job row is deleted last, so a
      // crash between them leaves a job pointing at a retired file rather than a
      // file nothing points at.
      report.files += await this.retire([job.fileId, job.errorReportFileId]);
      await this.imports.deleteById(job.id);
      report.importJobs += 1;
    }

    for (const job of await this.exports.terminalCreatedBefore(cutoff, BATCH)) {
      report.files += await this.retire([job.fileId]);
      await this.exports.deleteById(job.id);
      report.exportJobs += 1;
    }

    this.logger.log(
      `purged ${report.importJobs} import and ${report.exportJobs} export jobs, ${report.files} files`,
    );
    return report;
  }

  private async retire(fileIds: readonly (string | null)[]): Promise<number> {
    let retired = 0;
    for (const fileId of fileIds) {
      if (!fileId) continue;
      await this.documents.softDelete(fileId);
      retired += 1;
    }
    return retired;
  }
}
