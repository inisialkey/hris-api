import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { ApprovalModule } from '../approval';
import { AuthzModule } from '../authz';
import { SettingsModule } from '../settings';
import { AckItemsService } from './application/ack-items.service';
import { AcknowledgeService } from './application/acknowledge.service';
import { ApprovalTasksService } from './application/approval-tasks.service';
import { InboxEventHandlers } from './application/event-handlers.service';
import { InboxJobsService } from './application/inbox-jobs.service';
import { InboxListService } from './application/inbox-list.service';
import { inboxErrorStatus } from './domain/inbox.errors';
import { INBOX_OUTBOX, INBOX_PORT, INBOX_REPOSITORY } from './domain/inbox.ports';
import { InboxRepository } from './infrastructure/inbox.repository';
import { InboxController } from './presentation/inbox.controller';

registerErrorStatuses(inboxErrorStatus);

/**
 * Spine order 6, the second half — notification is the other, and the two never
 * mix. §1 draws the line in one sentence: *"a notification tells you something
 * happened; an inbox item waits for you."* Step activation produces both, and
 * they are disjoint by design — the push is the nudge, the item is the task.
 * This module registers no notification template and imports no notification
 * anything.
 *
 * **No `registerAuditedTables` call**, and that is the decision rather than the
 * omission: `inbox_items` has no audit-log §4.2 row, so its repository does not
 * extend `TenantScopedRepository`. Every row here is materialized by a handler
 * from an event whose cause was audited where it happened, and the one act a
 * human performs — acknowledging — is the fact announcement.md stamps and audits
 * on its own recipient row.
 *
 * **`ApprovalModule` is imported for `APPROVAL_TASK_PORT`**, the read port
 * approval-engine §7 gained this session (A-199, hris-handbook PR #33). §12's
 * activation event carries `{ instanceId, stepId, assigneeUserIds }` and an
 * inbox item needs five things it does not — the assignee row id BR-INB-004
 * makes the dedupe key first among them — all of it on the engine's tables,
 * which ADR-0001 rule 2 puts behind its port.
 *
 * **Two things ship with no caller**, both deliberately. `InboxPort`'s
 * `createAckItems`/`closeAckItems` are announcement.md's, and announcement is
 * Phase 3; inbox §13 records that three contracts written here before that
 * consumer existed all held without amendment, and building them now is what
 * makes the claim true rather than aspirational. And `inbox.item.acknowledged`
 * is written to the outbox that nothing dispatches yet.
 *
 * `InboxJobsService` has no schedule for the reason the approval SLA scan, the
 * audit anchor, the document sweeps and the notification purge have none.
 */
@Module({
  imports: [ApprovalModule, AuthzModule, SettingsModule],
  controllers: [InboxController],
  providers: [
    ApprovalTasksService,
    InboxListService,
    AcknowledgeService,
    AckItemsService,
    InboxEventHandlers,
    InboxJobsService,

    { provide: INBOX_REPOSITORY, useClass: InboxRepository },
    { provide: INBOX_PORT, useExisting: AckItemsService },
    { provide: INBOX_OUTBOX, useExisting: OutboxRepository },
  ],
  exports: [INBOX_PORT],
})
export class InboxModule {}
