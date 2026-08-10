import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { ROLE_HOLDER_PORT, type RoleHolderPort } from '../../authz';
import { DEFAULT_LOCALE } from '../domain/locale';
import {
  DELIVERY_REPOSITORY,
  NOTIFICATION_REPOSITORY,
  PREFERENCE_REPOSITORY,
  type DeliveryRepositoryPort,
  type NewDelivery,
  type NotificationRepositoryPort,
  type PreferenceRepositoryPort,
} from '../domain/notification.ports';
import type {
  FanoutCommand,
  NotificationChannel,
  Recipients,
  SendCommand,
  SendReport,
} from '../domain/notification.types';
import { render } from '../domain/render';
import { findTemplate, type TemplateDefinition } from '../domain/templates';

/** BR-NTF-009 — *"chunk recipients into jobs of ≤ 500"*. */
export const FANOUT_CHUNK = 500;

/**
 * BR-NTF-002's one pipeline: **render → preference → record**, reached by both
 * entry paths. There is no second implementation for events and no third for
 * fan-out — UC-NTF-006 is UC-NTF-001's per-recipient tail run over chunks, and
 * the handlers call the same port every other module does.
 *
 * **What this does synchronously and what it leaves for the dispatch jobs.**
 * BR-NTF-003 makes a send async and its stated reason is that a request path
 * must never wait on SMTP or FCM — *"never inline SMTP/FCM in a request"*, and
 * the auth flows depend on it because BR-AUTH-002/010's enumeration defence is a
 * response-timing promise. Nothing here touches a provider. What it does is two
 * bounded inserts, which is what makes the feed row durable at the moment the
 * cause happened (BR-NTF-008: *"the feed is the durable channel"*). The push and
 * email rows land `pending`, which is precisely the state `dispatch.push` and
 * `dispatch.email` consume, and those jobs are not in this repository yet —
 * there is no FCM or email provider wired, and ADR-0010 puts their scheduling on
 * a BullMQ worker that does not exist. `in_app` is `sent` at row creation, per
 * UC-NTF-003.
 */
@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepositoryPort,
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepositoryPort,
    @Inject(PREFERENCE_REPOSITORY) private readonly preferences: PreferenceRepositoryPort,
    @Inject(ROLE_HOLDER_PORT) private readonly roles: RoleHolderPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async send(command: SendCommand): Promise<SendReport> {
    const template = this.require(command.templateKey);
    const userIds = await this.resolve(command.recipients);
    return this.deliver(command, template, userIds);
  }

  /**
   * BR-NTF-009. The chunking is here rather than at the call site because every
   * caller would otherwise reproduce it, and one of them would get the bound
   * wrong. Each chunk is independently idempotent by BR-NTF-004 per recipient,
   * so a partially-completed fan-out re-run converges instead of duplicating.
   */
  async fanout(command: FanoutCommand): Promise<SendReport> {
    const template = this.require(command.templateKey);
    const unique = [...new Set(command.userIds)];
    const report: SendReport = { created: 0, deduped: 0, suppressed: 0 };

    for (let offset = 0; offset < unique.length; offset += FANOUT_CHUNK) {
      const chunk = unique.slice(offset, offset + FANOUT_CHUNK);
      const partial = await this.deliver(command, template, chunk);
      report.created += partial.created;
      report.deduped += partial.deduped;
      report.suppressed += partial.suppressed;
    }
    return report;
  }

  /**
   * The per-recipient tail, over one chunk.
   *
   * Sequential inside the loop, deliberately: this runs inside the caller's
   * unit of work, and a transaction rides one connection — `Promise.all` over
   * repository calls interleaves statements on a single socket
   * (coding-standards-nestjs §4). The one read that is *not* per recipient is
   * the preference lookup, which is why the port takes a list.
   */
  private async deliver(
    command: {
      templateKey: string;
      params: SendCommand['params'];
      dedupeKey: string;
      deepLink?: string;
    },
    template: TemplateDefinition,
    userIds: readonly string[],
  ): Promise<SendReport> {
    const report: SendReport = { created: 0, deduped: 0, suppressed: 0 };
    if (userIds.length === 0) return report;

    const optedOut = template.mandatory
      ? new Map<string, Set<NotificationChannel>>()
      : await this.preferences.optedOutChannels(userIds, command.templateKey);
    const now = this.clock.now();

    for (const userId of userIds) {
      // BR-NTF-006 renders per recipient, in their locale. The locale is the
      // same for all of them today and `locale.ts` says why; the render stays
      // inside the loop because the rule is per recipient and moving it out
      // would be an optimisation that has to be undone.
      const rendered = render(template, DEFAULT_LOCALE, command.params);
      if (rendered.unresolved.length > 0) {
        // §9's breadcrumb. Names only — BR-NTF-012 keeps title, body and params
        // out of telemetry, and a variable *name* is not its value.
        this.logger.warn(
          `notification template ${command.templateKey} left ${rendered.unresolved.join(', ')} unresolved`,
        );
      }

      const notification = await this.notifications.insertIfNew({
        userId,
        templateKey: command.templateKey,
        dedupeKey: command.dedupeKey,
        title: rendered.title,
        body: rendered.body,
        params: command.params,
        deepLink: command.deepLink,
      });

      // BR-NTF-004 — the dedupe index already answered. A redelivered handler
      // job stops here rather than writing a second set of delivery rows.
      if (!notification) {
        report.deduped += 1;
        continue;
      }

      const suppressed = optedOut.get(userId) ?? new Set<NotificationChannel>();
      const rows = template.channels.map((channel) =>
        this.deliveryFor(notification.id, channel, suppressed.has(channel), now),
      );
      await this.deliveries.createMany(rows);

      report.created += 1;
      report.suppressed += rows.filter((row) => row.status === 'skipped').length;
    }
    return report;
  }

  private deliveryFor(
    notificationId: string,
    channel: NotificationChannel,
    optedOut: boolean,
    now: Date,
  ): NewDelivery {
    // BR-NTF-005 — and only for optional templates, which is why `optedOut` is
    // always false above when the template is mandatory rather than being
    // re-checked here.
    if (optedOut) return { notificationId, channel, status: 'skipped' };

    // UC-NTF-003 — *"`in_app` is `sent` at row creation"*. There is no provider
    // to accept it and no later moment at which it becomes true.
    if (channel === 'in_app') return { notificationId, channel, status: 'sent', sentAt: now };

    return { notificationId, channel, status: 'pending' };
  }

  /**
   * §9's *"role-audience resolution at send time"*: membership is evaluated when
   * the send runs, not when the cause occurred, so a just-granted admin gets it
   * and a just-revoked one does not. Deliberate — notifications address people,
   * not history.
   *
   * A role key the tenant has no live role for resolves to nobody. That is a
   * send with no recipients, not a failure: the tenant deleted the role, and
   * refusing the whole send would take down the cause along with the notice.
   */
  private async resolve(recipients: Recipients): Promise<string[]> {
    if (recipients.kind === 'users') return [...new Set(recipients.userIds)];

    const roleId = await this.roles.findIdByKey(recipients.roleKey);
    if (!roleId) {
      this.logger.warn(`notification role audience ${recipients.roleKey} resolved to no role`);
      return [];
    }
    return [...new Set(await this.roles.holderUserIds(roleId, recipients.companyId))];
  }

  /**
   * An unregistered key is a defect in the caller, not a condition a user can be
   * told about — the reason `SettingsPort.resolve` throws on an unknown key.
   */
  private require(templateKey: string): TemplateDefinition {
    const template = findTemplate(templateKey);
    if (!template) throw new Error(`unregistered notification template: ${templateKey}`);
    return template;
  }
}
