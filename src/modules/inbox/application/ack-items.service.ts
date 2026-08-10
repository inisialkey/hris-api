import { Inject, Injectable, Logger } from '@nestjs/common';

import { INBOX_REPOSITORY, type InboxPort, type InboxRepositoryPort } from '../domain/inbox.ports';
import type { AckItemsReport, CreateAckItemsCommand } from '../domain/inbox.types';
import { DEFAULT_LOCALE } from '../domain/locale';
import { ACKNOWLEDGMENT_TITLE, renderTitle } from '../domain/titles';

/** UC-INB-005 — *"chunked inserts (≤ 500 per job, notification BR-NTF-009 pattern)"*. */
export const ACK_CHUNK = 500;

/**
 * UC-INB-005, the port announcement.md consumes — **and it ships with no
 * caller**, because announcement is Phase 3.
 *
 * That is the point rather than a gap. inbox.md §13 records that three contracts
 * written here before the consumer existed all held without amendment —
 * `dedupe_key` = the announcement id, `closed_reason = 'retracted'`, and
 * `INB_ITEM_CLOSED` on an ack against a retracted post — and building them now
 * is what makes that claim true rather than aspirational. The one signature that
 * did move (`dueAt`, added when announcement.md arrived) is here in its current
 * shape.
 */
@Injectable()
export class AckItemsService implements InboxPort {
  private readonly logger = new Logger(AckItemsService.name);

  constructor(@Inject(INBOX_REPOSITORY) private readonly items: InboxRepositoryPort) {}

  /**
   * One item per recipient, chunked. Each chunk is independently idempotent by
   * BR-INB-004 on `(tenant, user, announcementId)`, so a fan-out job that failed
   * halfway converges on retry instead of duplicating — which is what UC-ANN-005
   * means by *"every step idempotent; a retry converges"*.
   */
  async createAckItems(command: CreateAckItemsCommand): Promise<AckItemsReport> {
    const rendered = renderTitle(ACKNOWLEDGMENT_TITLE, DEFAULT_LOCALE, command.titleParams);
    if (rendered.unresolved.length > 0) {
      // Names only — the subject is the announcement's title, which is content.
      this.logger.warn(`inbox ack title left ${rendered.unresolved.join(', ')} unresolved`);
    }

    const unique = [...new Set(command.userIds)];
    const report: AckItemsReport = { created: 0, deduped: 0 };

    for (let offset = 0; offset < unique.length; offset += ACK_CHUNK) {
      const chunk = unique.slice(offset, offset + ACK_CHUNK);
      const created = await this.items.insertIfNew(
        chunk.map((userId) => ({
          userId,
          type: 'acknowledgment' as const,
          // BR-INB-004 — the announcement id, exactly as inbox wrote it into
          // this rule before announcement.md existed.
          dedupeKey: command.announcementId,
          title: rendered.title,
          subtitle: rendered.subtitle,
          params: command.titleParams,
          sourceRef: { announcementId: command.announcementId },
          // The caller's, not ours: announcement owns the screen this opens, and
          // it is the only module in the system that can name its own route
          // (A-199 — nothing else has one to name).
          deepLink: command.deepLink,
          // BR-INB-009 — `acknowledge_by`, and absent for most announcements, in
          // which case the item sorts by age like any other. There are no
          // mechanics behind it: announcement registers no reminder cron,
          // because an `open` item never purges and is therefore already a
          // permanent nag.
          dueAt: command.dueAt ?? null,
        })),
      );
      report.created += created;
      report.deduped += chunk.length - created;
    }

    return report;
  }

  /**
   * UC-INB-008's other half. `open → closed/retracted`; a `done` item is
   * somebody's recorded acknowledgment and stays exactly as it is, which is what
   * keeps announcement's acknowledgment rate reproducible after a retraction.
   */
  closeAckItems(announcementId: string): Promise<number> {
    return this.items.closeByDedupeKey(announcementId, 'retracted');
  }
}
