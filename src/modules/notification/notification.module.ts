import { Module } from '@nestjs/common';

import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuthzModule } from '../authz';
import { SettingsModule } from '../settings';
import { NotificationEventHandlers } from './application/event-handlers.service';
import { FeedService } from './application/feed.service';
import { NotificationJobsService } from './application/notification-jobs.service';
import { NotificationStatsService } from './application/notification-stats.service';
import { PreferenceService } from './application/preference.service';
import { SendService } from './application/send.service';
import { notificationErrorStatus } from './domain/notification.errors';
import {
  DELIVERY_REPOSITORY,
  NOTIFICATION_PORT,
  NOTIFICATION_REPOSITORY,
  NOTIFICATION_STATS_PORT,
  PREFERENCE_REPOSITORY,
} from './domain/notification.ports';
import { DeliveryRepository } from './infrastructure/delivery.repository';
import { NotificationRepository } from './infrastructure/notification.repository';
import { PreferenceRepository } from './infrastructure/preference.repository';
import { NotificationsController } from './presentation/notifications.controller';

registerErrorStatuses(notificationErrorStatus);

/**
 * Spine order 6, the first half — inbox is the other and is a separate module.
 *
 * **No `registerAuditedTables` call**, and that is the decision rather than the
 * omission: none of the three tables has an audit-log §4.2 row, so none of their
 * repositories extends `TenantScopedRepository`. A notification is a derived
 * fact whose cause was audited where it happened, and the preference rows are a
 * user's own switches over their own traffic.
 *
 * **The registry ships whole and most of it is inert.** §4.2 is the platform
 * seed and this module owns it, so all forty-five templates are registered —
 * including the thirty-odd whose modules have not been built. A template nobody
 * sends costs a row in the preference matrix and nothing else, and a module
 * arriving later calls the port with a key that is already there. That is the
 * mirror image of the line document-storage drew: there a *policy* was complete
 * and its gate undefined; here the *definition* is complete and only its sender
 * is missing.
 *
 * **Push and email have no dispatch.** The pipeline records their delivery rows
 * `pending`, which is the state `dispatch.push` and `dispatch.email` consume,
 * and neither job is here: there is no FCM or email provider wired, no
 * credentials to wire one with, and ADR-0010 puts their scheduling on a BullMQ
 * worker this repository does not have. `in_app` is complete — `sent` at row
 * creation, per UC-NTF-003 — which is the channel BR-NTF-008 calls the durable
 * one.
 *
 * `NotificationJobsService` has no schedule for the reason the approval SLA
 * scan, the audit anchor and the document sweeps have none.
 */
@Module({
  imports: [AuthzModule, SettingsModule],
  controllers: [NotificationsController],
  providers: [
    SendService,
    FeedService,
    PreferenceService,
    NotificationEventHandlers,
    NotificationJobsService,
    NotificationStatsService,

    { provide: NOTIFICATION_REPOSITORY, useClass: NotificationRepository },
    { provide: DELIVERY_REPOSITORY, useClass: DeliveryRepository },
    { provide: PREFERENCE_REPOSITORY, useClass: PreferenceRepository },
    { provide: NOTIFICATION_PORT, useExisting: SendService },
    { provide: NOTIFICATION_STATS_PORT, useExisting: NotificationStatsService },
  ],
  exports: [NOTIFICATION_PORT, NOTIFICATION_STATS_PORT],
})
export class NotificationModule {}
