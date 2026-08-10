import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { ApprovalTasksService, type TerminalOutcome } from './approval-tasks.service';

/**
 * ADR-0010's envelope, narrowed to what a handler reads. `payload` arrives
 * `unknown`-shaped and is narrowed per event (coding-standards-nestjs §1).
 */
export interface ConsumedEvent {
  id: string;
  name: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** What a handler did, for the relay's log and for the tests. */
export interface HandledReport {
  /** Items created (materialization) or moved (completion, closure). */
  affected: number;
}

/**
 * UC-INB-001 and UC-INB-002 — the seven `on.<event>` handlers of §12, as bodies.
 *
 * **No relay yet**, for the reason every job in this repository has no schedule:
 * ADR-0010 dispatches outbox rows from a BullMQ worker and there is none here.
 * `handle` is the seam that worker calls — one method keyed by event name, so
 * the relay needs no per-event registration table to grow.
 *
 * **Every handler is idempotent, and none of them by an `eventId` guard.** The
 * state itself carries it: materialization collides on `uq_inbox_items_dedupe`,
 * completion and closure both filter on `status = 'open'` and so are no-ops the
 * second time. ADR-0010 accepts either — *"a processed-event guard **or** a
 * naturally idempotent effect"* — and the natural one is what makes the
 * out-of-order case correct as well as the redelivered one: a terminal that
 * arrives before its own activation closes nothing, the activation then
 * materializes items, and the next terminal or the SLA ladder finds them.
 */
@Injectable()
export class InboxEventHandlers {
  private readonly logger = new Logger(InboxEventHandlers.name);

  constructor(
    private readonly tasks: ApprovalTasksService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `null` when the event is not one this module registered. */
  async handle(event: ConsumedEvent): Promise<HandledReport | null> {
    switch (event.name) {
      case 'approval.step.activated': {
        const stepId = string(event, 'stepId');
        if (!stepId) return this.missing(event, 'stepId');
        return { affected: await this.tasks.materialize(stepId) };
      }

      case 'approval.assignee.acted': {
        // BR-INB-006 — the actor's own item, now, whether or not the step ended.
        // `actorUserId` is the item's `user_id` even under delegation: the
        // engine re-points the seat to the live delegate at activation
        // (BR-APRV-009), so the delegate is the assignee and acts as themselves.
        const assigneeId = string(event, 'assigneeId');
        const actorUserId = string(event, 'actorUserId');
        if (!assigneeId) return this.missing(event, 'assigneeId');
        if (!actorUserId) return this.missing(event, 'actorUserId');
        return {
          affected: await this.tasks.completeActor(actorUserId, assigneeId, this.clock.now()),
        };
      }

      case 'approval.step.decided': {
        // The siblings, not the actor — their own event already completed them.
        const instanceId = string(event, 'instanceId');
        const stepId = string(event, 'stepId');
        if (!instanceId) return this.missing(event, 'instanceId');
        if (!stepId) return this.missing(event, 'stepId');
        return { affected: await this.tasks.closeSiblings(instanceId, stepId) };
      }

      case 'approval.instance.approved':
        return this.closeInstance(event, 'approved');
      case 'approval.instance.rejected':
        return this.closeInstance(event, 'rejected');
      case 'approval.instance.returned':
        return this.closeInstance(event, 'returned');
      case 'approval.instance.cancelled':
        return this.closeInstance(event, 'cancelled');

      default:
        // Not an error: the relay dispatches one job per (event, subscriber) and
        // a name this module never registered simply is not ours.
        return null;
    }
  }

  private async closeInstance(
    event: ConsumedEvent,
    outcome: TerminalOutcome,
  ): Promise<HandledReport | null> {
    const instanceId = string(event, 'instanceId');
    if (!instanceId) return this.missing(event, 'instanceId');
    return { affected: await this.tasks.closeInstance(instanceId, outcome) };
  }

  /**
   * A payload missing a field its own contract declares is a producer defect,
   * and doing nothing quietly would hide it. Loud, and not a throw: retrying the
   * job cannot make the field appear.
   */
  private missing(event: ConsumedEvent, field: string): null {
    this.logger.error(`event ${event.name} (${event.id}) carries no ${field}`);
    return null;
  }
}

function string(event: ConsumedEvent, field: string): string | null {
  const value = event.payload[field];
  return typeof value === 'string' ? value : null;
}
