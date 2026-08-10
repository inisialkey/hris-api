import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import { INBOX_REPOSITORY, type InboxRepositoryPort } from '../domain/inbox.ports';

const RETENTION_KEY = 'inbox.retention_days';
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
 * **No schedule yet**, for the reason the approval SLA scan, the audit anchor,
 * the document sweeps and the notification purge have none: ADR-0010 puts crons
 * on BullMQ and this repository has no worker. The body is the part that has to
 * be right; a scheduler is one decorator once the worker lands, and a body
 * written later against a live queue is the part nobody can test.
 */
@Injectable()
export class InboxJobsService {
  constructor(
    @Inject(INBOX_REPOSITORY) private readonly items: InboxRepositoryPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `cron.inbox.purge` — BR-INB-010.
   *
   * **`open` items never purge**, and that predicate is the whole rule: a
   * pending task must not silently vanish, so an instance stuck for two hundred
   * days keeps its task and stays the approval engine's problem to surface
   * (BR-APRV-006) rather than becoming nobody's. The consequence is stated in §9
   * and accepted there: an offboarded user's open items are permanent residue
   * until the instance reaches a terminal.
   */
  async purge(): Promise<PurgeReport> {
    const days = await this.settings.resolve<number>(RETENTION_KEY);
    const cutoff = new Date(this.clock.now().getTime() - days * DAY_MS);
    return { purged: await this.items.deleteClosedBefore(cutoff, PURGE_BATCH) };
  }
}
