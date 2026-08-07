import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import { CATEGORY_POLICIES, findCategory, type RetentionPolicy } from '../domain/categories';
import {
  FILE_REPOSITORY,
  STORAGE_PORT,
  type FileRepositoryPort,
  type StoragePort,
} from '../domain/document.ports';
import type { FileRow } from '../domain/document.types';

/** BR-DOC-003 — the staging prefix's lifecycle rule, mirrored in the sweep. */
const STAGING_HOURS = 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const EXPIRY_WINDOW_KEY = 'document.expiry_reminder_days';

/**
 * A batch ceiling, not a correctness bound: the job is idempotent and the next
 * run picks up what this one left. Raise it if a tenant's backlog outgrows a
 * day's schedule.
 */
const PURGE_BATCH = 500;

export interface SweepReport {
  purgedRows: number;
}

export interface ExpiryReport {
  reminded: number;
  skipped: number;
}

export interface PurgeReport {
  purged: number;
  retained: number;
}

/**
 * §12's three jobs, as bodies.
 *
 * **No schedule yet**, for the reason the approval SLA scan and the audit anchor
 * have none: ADR-0010 puts crons on BullMQ and this repository has no worker.
 * The body is the part that has to be right; a scheduler is one decorator once
 * the worker lands, and a body written later against a live queue is the part
 * nobody can test.
 */
@Injectable()
export class DocumentJobsService {
  private readonly logger = new Logger(DocumentJobsService.name);

  constructor(
    @Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `cron.document.staged-sweep` — BR-DOC-003.
   *
   * Rows only. The objects died with the staging prefix's own 24 h lifecycle
   * rule, which is the bucket's job and not this one's; calling `remove` on each
   * would be one storage round trip per row to delete what is already gone.
   */
  async sweepStaged(): Promise<SweepReport> {
    const cutoff = new Date(this.clock.now().getTime() - STAGING_HOURS * HOUR_MS);
    const stale = await this.repository.staleStaged(cutoff);

    for (const file of stale) {
      await this.repository.hardDelete(file.id);
    }
    return { purgedRows: stale.length };
  }

  /**
   * `cron.document.expiry-scan` — UC-DOC-006, idempotent via `expiry_reminded_at`.
   *
   * The stamp is the whole record. §12 registers no event for a reminder and
   * §13's `document.expiring` template belongs to the notification module, which
   * does not exist yet — so this writes the stamp the template will read and
   * invents no event name to fill the gap (the approval SLA reminder settled the
   * same question the same way).
   *
   * Tenant scope on the window key: `files` carries no company, and the owning
   * entity is where one would come from. A company-level override is therefore
   * invisible here — if that ever matters, the owner grows a `companyOf(ref)`.
   */
  async scanExpiry(): Promise<ExpiryReport> {
    const days = await this.settings.resolve<number>(EXPIRY_WINDOW_KEY);
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);

    const due = await this.repository.dueForExpiryReminder(horizon);
    const report: ExpiryReport = { reminded: 0, skipped: 0 };

    for (const file of due) {
      // `training_certificate` carries `expiryReminders: false` and its files
      // should hold no expiry at all (BR-TRN-013 moved the date to the
      // credential row). Skipping without stamping keeps the row visible if one
      // ever appears, rather than silently marking it handled.
      if (!CATEGORY_POLICIES[file.category]?.expiryReminders) {
        report.skipped += 1;
        continue;
      }
      await this.repository.stampExpiryReminded(file.id, now);
      report.reminded += 1;
    }
    return report;
  }

  /**
   * `cron.document.purge` — BR-DOC-009/010, **object then row, one direction**.
   *
   * A crash between the two leaves a soft-deleted row whose object is already
   * gone; the next run calls `remove` again, which is idempotent, and finishes.
   * The reverse order would leave an object no row points at — storage nobody
   * pays attention to and nobody can find.
   */
  async purge(): Promise<PurgeReport> {
    const now = this.clock.now();
    const report: PurgeReport = { purged: 0, retained: 0 };

    for (const file of await this.repository.softDeletedOnOrBefore(now, PURGE_BATCH)) {
      const retention = CATEGORY_POLICIES[file.category]?.retention ?? { kind: 'none' };
      if (await this.retained(retention, file.deletedAt ?? now, now)) {
        report.retained += 1;
        continue;
      }
      await this.collect(file);
      report.purged += 1;
    }

    // BR-DOC-010's other population: selfies age out of a *live* row, no delete
    // involved. Only categories somebody owns are asked, which is also what
    // keeps the job from resolving a retention key whose module has not shipped.
    for (const [key, policy] of Object.entries(CATEGORY_POLICIES)) {
      if (policy.retention.kind !== 'after_create' || !findCategory(key)) continue;

      const cutoff = new Date(now.getTime() - (await this.window(policy.retention)));
      for (const file of await this.repository.committedCreatedBefore(key, cutoff, PURGE_BATCH)) {
        await this.collect(file);
        report.purged += 1;
      }
    }
    return report;
  }

  private async collect(file: FileRow): Promise<void> {
    await this.storage.remove(file.storagePath);
    await this.repository.hardDelete(file.id);
    this.logger.log(`purged file ${file.id} (${file.category})`);
  }

  private async retained(retention: RetentionPolicy, deletedAt: Date, now: Date): Promise<boolean> {
    switch (retention.kind) {
      case 'none':
        return false;
      // database-conventions §4.4's payroll class. The number is a retention
      // policy and not this module's to type; nothing here collects those rows,
      // which is also why BR-DOC-009 refuses client deletes on them.
      case 'statutory':
        return true;
      case 'after_delete':
        return deletedAt.getTime() + (await this.window(retention)) > now.getTime();
      case 'after_create':
        // Handled by the second pass, which measures from `created_at`.
        return true;
    }
  }

  private async window(
    retention: Extract<RetentionPolicy, { settingKey: string }>,
  ): Promise<number> {
    const value = await this.settings.resolve<number>(retention.settingKey);
    // Months as 30 days: the setting is a retention horizon, not a calendar
    // obligation, and a purge that lands a day either side of a month boundary
    // is the same purge.
    return retention.unit === 'days' ? value * DAY_MS : value * 30 * DAY_MS;
  }
}
