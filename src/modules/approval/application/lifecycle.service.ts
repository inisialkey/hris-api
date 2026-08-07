import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import {
  APPROVAL_OUTBOX,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ApprovalEventName,
  type ApprovalOutboxPort,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
} from '../domain/approval.ports';
import type { InstanceRow, InstanceStatus } from '../domain/approval.types';

/** The four §12 terminal events — every instance status except the live one. */
export type TerminalStatus = Exclude<InstanceStatus, 'in_progress'>;

/**
 * How an instance ends, in one place.
 *
 * Submit, decide and cancel all reach it, and a use case may not inject another
 * use case (coding-standards-nestjs §2) — same-module composition is a domain
 * service, which is this. It matters here more than usual: three of the four
 * terminal events are emitted from three different files, and an ending that
 * forgot its event would leave the owning module holding a request nobody ever
 * told it was decided.
 */
@Injectable()
export class InstanceLifecycleService {
  constructor(
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(APPROVAL_OUTBOX) private readonly outbox: ApprovalOutboxPort,
  ) {}

  /**
   * Status, completion stamp, the `pending` steps marked `skipped` so a timeline
   * shows what never ran, and the §12 event the owning module listens for.
   *
   * **No `skipped` action row per never-activated step.** Activation writes one
   * when *it* skips a step, because there the reason is a policy an admin
   * configured and nothing else records it. Here the reason is the decision that
   * ended the instance, whose own action row is already in the same trail — a
   * row per untouched step would repeat it N times.
   */
  async terminate(instance: InstanceRow, status: TerminalStatus, now: Date): Promise<boolean> {
    const advanced = await this.instances.advance(instance.id, instance.version, { status }, now);
    if (!advanced) return false;

    await this.steps.skipRemaining(instance.id, instance.currentStepIndex);
    await this.emit(`approval.instance.${status}`, instance.id, {
      instanceId: instance.id,
      requestType: instance.requestType,
      requestId: instance.requestId,
    });
    return true;
  }

  async emit(
    name: ApprovalEventName,
    instanceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.emit({
      name,
      tenantId: requireTenantContext().tenantId,
      aggregateId: instanceId,
      payload,
    });
  }
}
