import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { approvalErrors } from '../domain/approval.errors';
import {
  ACTION_REPOSITORY,
  ASSIGNEE_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ActionRepositoryPort,
  type ApprovalPort,
  type AssigneeRepositoryPort,
  type DecisionResult,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
  type SubmitCommand,
} from '../domain/approval.ports';
import { DecideUseCase } from './decide.use-case';
import { InstanceLifecycleService } from './lifecycle.service';
import { SubmitUseCase } from './submit.use-case';

/**
 * `ApprovalPort`'s implementation — the five methods §7 declares, and nothing
 * else. Composition only: each one is a use case, and the port exists so that a
 * consuming module binds to an interface in this module's facade rather than to
 * a class in its application layer (ADR-0001 §1).
 *
 * UC-APRV-005 lives here rather than in a file of its own because cancel is
 * three checks and a terminal write, and a `CancelUseCase` wrapping them would
 * be a file that only forwards.
 */
@Injectable()
export class ApprovalService implements ApprovalPort {
  constructor(
    private readonly submitter: SubmitUseCase,
    private readonly decider: DecideUseCase,
    private readonly lifecycle: InstanceLifecycleService,
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  submit(cmd: SubmitCommand): Promise<Result<{ instanceId: string }>> {
    return this.submitter.submit(cmd);
  }

  approve(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment?: string,
  ): Promise<Result<DecisionResult>> {
    return this.decider.decide(actorUserId, requestType, requestId, 'approve', comment);
  }

  reject(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment: string,
  ): Promise<Result<DecisionResult>> {
    return this.decider.decide(actorUserId, requestType, requestId, 'reject', comment);
  }

  return(
    actorUserId: string,
    requestType: string,
    requestId: string,
    comment: string,
  ): Promise<Result<DecisionResult>> {
    return this.decider.decide(actorUserId, requestType, requestId, 'return', comment);
  }

  /**
   * UC-APRV-005. **Requester identity is checked here**, as BR-APRV-011 states
   * it — *"cancel is requester-only while `in_progress`"* — and a module may
   * refuse earlier in its own endpoint but never later. `APRV_NOT_AN_APPROVER`
   * is the registered code for "you hold the permission and may not act on this
   * instance", which is exactly what a non-requester's cancel is.
   */
  async cancel(actorUserId: string, requestType: string, requestId: string): Promise<Result<void>> {
    const instance = await this.instances.findNewestForRequest(requestType, requestId);
    if (!instance) return fail(sharedErrors.notFound());
    if (instance.status !== 'in_progress') {
      return fail(approvalErrors.instanceNotActionable({ status: instance.status }));
    }
    if (instance.requesterUserId !== actorUserId) return fail(approvalErrors.notAnApprover());

    const now = this.clock.now();
    const step = await this.steps.findByIndex(instance.id, instance.currentStepIndex);
    if (step && step.status === 'active') {
      await this.assignees.closeRemaining(step.id, now);
      await this.steps.decide(step.id, step.version, 'skipped', now);
    }

    await this.actions.append({
      instanceId: instance.id,
      actorUserId,
      action: 'cancel',
    });

    const terminated = await this.lifecycle.terminate(instance, 'cancelled', now);
    return terminated ? ok(undefined) : fail(approvalErrors.stepAlreadyDecided());
  }
}
