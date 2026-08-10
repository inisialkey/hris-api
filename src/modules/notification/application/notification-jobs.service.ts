import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import {
  NOTIFICATION_REPOSITORY,
  type NotificationRepositoryPort,
} from '../domain/notification.ports';

const RETENTION_KEY = 'notification.retention_days';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A batch ceiling, not a correctness bound: the job is idempotent and the next
 * run takes what this one left.
 */
const PURGE_BATCH = 500;

export interface PurgeReport {
  purged: number;
}

/**
 * §12's one cron, as a body.
 *
 * **No schedule yet**, for the reason the approval SLA scan, the audit anchor
 * and the document sweeps have none: ADR-0010 puts crons on BullMQ and this
 * repository has no worker. The body is the part that has to be right; a
 * scheduler is one decorator once the worker lands, and a body written later
 * against a live queue is the part nobody can test.
 */
@Injectable()
export class NotificationJobsService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepositoryPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `cron.notification.purge` — BR-NTF-010.
   *
   * **Unread does not exempt a row.** The rule says so in as many words: the
   * feed is a feed and not an archive, and anything that had to survive is a
   * document in document-storage or a row in the module that owns the fact.
   * Deliveries follow through the `ON DELETE CASCADE` on their foreign key;
   * `notification_preferences` is a separate table keyed by template rather than
   * by notification, and nothing here touches it — a purge that forgot someone's
   * opt-outs would turn a retention window into a consent reset.
   */
  async purge(): Promise<PurgeReport> {
    const days = await this.settings.resolve<number>(RETENTION_KEY);
    const cutoff = new Date(this.clock.now().getTime() - days * DAY_MS);
    return { purged: await this.notifications.deleteCreatedBefore(cutoff, PURGE_BATCH) };
  }
}
