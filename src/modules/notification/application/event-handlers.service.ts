import { Injectable, Logger } from '@nestjs/common';

import type { SendReport, TemplateParams } from '../domain/notification.types';
import { SendService } from './send.service';

/**
 * ADR-0010's envelope, narrowed to what a handler reads. `payload` arrives
 * `unknown`-shaped and is narrowed per event (coding-standards-nestjs §1).
 */
export interface ConsumedEvent {
  /** The outbox row id — BR-NTF-004's dedupe key for every event-driven send. */
  id: string;
  name: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * UC-NTF-001 — the `on.<event>` handlers of §12, as bodies.
 *
 * **No relay yet**, for the reason every job in this repository has no schedule:
 * ADR-0010 dispatches outbox rows from a BullMQ worker and there is none here.
 * `handle` is the seam that worker calls — one method, keyed by event name, so
 * the relay needs no per-event registration table to grow.
 *
 * Each handler does one thing: turn an event into a template key and a set of
 * recipients. Everything after that — preference, render, dedupe, delivery rows
 * — is `SendService`, because BR-NTF-002 says both entry paths converge on one
 * pipeline and a handler with its own would be the second one.
 *
 * **The recipients come from the payload, never from a read.** Every event in
 * §12's consumed list names its people (`assigneeUserIds`, `escalatedToUserIds`,
 * `requesterUserId`, `userId`), which is not a coincidence: the alternative is
 * this module reading another module's tables, and ADR-0001 rule 2 forbids it.
 *
 * **No deep links.** BR-NTF-011 wants a go_router path on every row and cites
 * mobile-flutter §7, which is the sync-engine seam — no route grammar exists
 * anywhere in the handbook, and a path invented here is a client contract
 * nobody agreed to (A-198). `deepLink` is nullable in §4.1, mobile owns the
 * dead-link degradation BR-NTF-011 specifies, and the port carries `deepLink?`
 * so a caller that knows its own route supplies it.
 */
@Injectable()
export class NotificationEventHandlers {
  private readonly logger = new Logger(NotificationEventHandlers.name);

  constructor(private readonly sends: SendService) {}

  /** `null` when the event maps to no template — see `approval.instance.cancelled`. */
  async handle(event: ConsumedEvent): Promise<SendReport | null> {
    switch (event.name) {
      case 'approval.step.activated':
        return this.toUsers(event, 'approval.step_activated', 'assigneeUserIds');

      case 'approval.step.escalated':
        return this.toUsers(event, 'approval.step_escalated', 'escalatedToUserIds');

      case 'approval.instance.approved':
      case 'approval.instance.rejected':
      case 'approval.instance.returned':
        return this.toUser(event, 'approval.instance_decided', 'requesterUserId');

      // Registered as consumed in §12 and mapped to nothing on purpose. §4.2
      // sends `approval.instance_decided` to *"the requester (approved/rejected/
      // returned + comment)"*, and a cancellation is the requester's own act —
      // telling somebody what they just did is not a notification.
      case 'approval.instance.cancelled':
        return null;

      case 'auth.password.changed':
        return this.toUser(event, 'auth.password_changed', 'userId');

      // §4.2's audience is *"remaining active devices"*, which is a push-target
      // rule and not a second recipient: one row for the account's owner, and
      // BR-NTF-007 decides which of their devices it reaches at dispatch. The
      // revoked device is excluded there — offline-sync §8's promise that a
      // revocation notice never lands on the phone it revoked.
      case 'auth.device.revoked':
        return this.toUser(event, 'auth.device_revoked', 'userId');

      case 'authz.assignment.granted':
      case 'authz.assignment.revoked':
        return this.toUser(event, 'authz.access_changed', 'userId');

      default:
        // Not an error: the relay dispatches one job per (event, subscriber) and
        // a name this module never registered simply is not ours.
        return null;
    }
  }

  private toUsers(event: ConsumedEvent, templateKey: string, field: string): Promise<SendReport> {
    return this.sends.send({
      templateKey,
      recipients: { kind: 'users', userIds: stringArray(event, field, this.logger) },
      params: params(event),
      dedupeKey: event.id,
    });
  }

  private async toUser(
    event: ConsumedEvent,
    templateKey: string,
    field: string,
  ): Promise<SendReport | null> {
    const userId = string(event, field);
    if (!userId) {
      // A payload missing the recipient it declares is a producer defect, and a
      // send with no recipients would hide it. Loud, and not a throw: retrying
      // the job cannot make the field appear.
      this.logger.error(`event ${event.name} (${event.id}) carries no ${field}`);
      return null;
    }
    return this.sends.send({
      templateKey,
      recipients: { kind: 'users', userIds: [userId] },
      params: params(event),
      dedupeKey: event.id,
    });
  }
}

/**
 * The template variables an event can supply. Only primitives survive: a nested
 * object in `params` would be stored in the jsonb column and rendered as
 * `[object Object]`, and the templates that take variables take scalars.
 */
function params(event: ConsumedEvent): TemplateParams {
  const scalars: TemplateParams = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (typeof value === 'string' || typeof value === 'number') scalars[key] = value;
  }
  return scalars;
}

function string(event: ConsumedEvent, field: string): string | null {
  const value = event.payload[field];
  return typeof value === 'string' ? value : null;
}

function stringArray(event: ConsumedEvent, field: string, logger: Logger): string[] {
  const value = event.payload[field];
  if (!Array.isArray(value)) {
    logger.error(`event ${event.name} (${event.id}) carries no ${field}`);
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}
