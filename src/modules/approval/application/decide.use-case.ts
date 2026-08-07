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
  type AssigneeRepositoryPort,
  type DecisionResult,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
} from '../domain/approval.ports';
import type { InstanceRow, StepRow } from '../domain/approval.types';
import { stepOutcome } from '../domain/quorum';
import { ActivationService } from './activation.service';
import { InstanceLifecycleService } from './lifecycle.service';

type Decision = 'approve' | 'reject' | 'return';

/**
 * UC-APRV-002, UC-APRV-003 and UC-APRV-004 — one path, because they differ in
 * three places and share the rest: the two-gate check, the claim, the trail, the
 * quorum evaluation and the progression are identical whichever button was
 * pressed.
 */
@Injectable()
export class DecideUseCase {
  constructor(
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    private readonly activation: ActivationService,
    private readonly lifecycle: InstanceLifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async decide(
    actorUserId: string,
    requestType: string,
    requestId: string,
    decision: Decision,
    comment?: string,
  ): Promise<Result<DecisionResult>> {
    // BR-APRV-008: reject and return refuse **before any state change**. Checked
    // first for exactly that reason — a comment-less rejection that had already
    // claimed the assignee row would consume the approver's seat and then fail.
    if (decision !== 'approve' && !comment?.trim()) {
      return fail(approvalErrors.commentRequired());
    }

    const instance = await this.instances.findNewestForRequest(requestType, requestId);
    if (!instance) return fail(sharedErrors.notFound());
    if (instance.status !== 'in_progress') {
      return fail(approvalErrors.instanceNotActionable({ status: instance.status }));
    }

    const step = await this.steps.findByIndex(instance.id, instance.currentStepIndex);
    if (!step || step.status !== 'active') {
      return fail(approvalErrors.instanceNotActionable({ status: instance.status }));
    }

    /**
     * Gate two, and the only gate this port owns (BR-APRV-012). Reaching here
     * means the module's static `@RequirePermission` already passed, so a caller
     * with no live seat holds the permission by construction — which is the
     * condition §11 registers as 403 `APRV_NOT_AN_APPROVER`. The 404 half of
     * BR-APRV-012 belongs to the *read* endpoints, where the caller may hold no
     * permission at all.
     */
    const assignee = await this.assignees.findSeat(step.id, actorUserId);
    if (!assignee) return fail(approvalErrors.notAnApprover());
    // A seat that is no longer `active` is the losing half of an `any`-quorum
    // race, read one statement too late: the winner's `closeRemaining` already
    // ran. §9 says that caller gets `APRV_STEP_ALREADY_DECIDED`, and it is a
    // different fact from having no seat at all.
    if (assignee.status !== 'active') return fail(approvalErrors.stepAlreadyDecided());

    const now = this.clock.now();
    const claimed = await this.assignees.claim(
      assignee.id,
      assignee.version,
      decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'skipped',
      now,
    );
    if (!claimed) return fail(approvalErrors.stepAlreadyDecided());

    await this.actions.append({
      instanceId: instance.id,
      stepId: step.id,
      actorUserId,
      delegateOfUserId: assignee.delegateOfUserId,
      action: decision,
      comment: comment ?? null,
    });

    // §12, grilled 2026-08-02: emitted on **every** recorded decision, including
    // a partial `all`-quorum approval that leaves the step active, so the inbox
    // completes the actor's own item now rather than at step end.
    await this.lifecycle.emit('approval.assignee.acted', instance.id, {
      instanceId: instance.id,
      stepId: step.id,
      assigneeId: assignee.id,
      actorUserId,
      action: decision,
    });

    return decision === 'return'
      ? this.finishReturn(instance, step, actorUserId, now)
      : this.settleStep(instance, step, actorUserId, now);
  }

  /**
   * BR-APRV-011: a return ends the instance immediately whatever the quorum
   * says. The acting seat is claimed `skipped` rather than a fourth status —
   * `approval_step_status` has three outcomes and the authoritative record of
   * *who* returned it is the action row (BR-APRV-015, BR-AUD-004).
   */
  private async finishReturn(
    instance: InstanceRow,
    step: StepRow,
    actorUserId: string,
    now: Date,
  ): Promise<Result<DecisionResult>> {
    const decided = await this.steps.decide(step.id, step.version, 'skipped', now);
    if (!decided) return fail(approvalErrors.stepAlreadyDecided());

    await this.assignees.closeRemaining(step.id, now);
    await this.lifecycle.emit('approval.step.decided', instance.id, {
      instanceId: instance.id,
      stepId: step.id,
      outcome: 'returned',
      actorUserId,
    });
    await this.lifecycle.terminate(instance, 'returned', now);

    return ok({
      instanceId: instance.id,
      instanceStatus: 'returned',
      stepIndex: step.stepIndex,
      stepStatus: 'skipped',
    });
  }

  /** BR-APRV-008's quorum, evaluated over the rows as they now stand. */
  private async settleStep(
    instance: InstanceRow,
    step: StepRow,
    actorUserId: string,
    now: Date,
  ): Promise<Result<DecisionResult>> {
    const rows = await this.assignees.listByStep(step.id);
    const outcome = stepOutcome(rows, step.quorum);

    if (outcome === 'active') {
      // `all`-quorum partial approval: the step holds, the remaining assignees
      // are still actionable (UC-APRV-002).
      return ok({
        instanceId: instance.id,
        instanceStatus: 'in_progress',
        stepIndex: step.stepIndex,
        stepStatus: 'active',
      });
    }

    // The step-level version guard is what decides an `any`-quorum race: both
    // approvers claimed their own rows, both arrive here, one `UPDATE` matches.
    // The loser's whole transaction — claim included — rolls back on the failure.
    const decided = await this.steps.decide(step.id, step.version, outcome, now);
    if (!decided) return fail(approvalErrors.stepAlreadyDecided());

    await this.assignees.closeRemaining(step.id, now);
    await this.lifecycle.emit('approval.step.decided', instance.id, {
      instanceId: instance.id,
      stepId: step.id,
      outcome,
      actorUserId,
    });

    if (outcome === 'rejected') {
      await this.lifecycle.terminate(instance, 'rejected', now);
      return ok({
        instanceId: instance.id,
        instanceStatus: 'rejected',
        stepIndex: step.stepIndex,
        stepStatus: 'rejected',
      });
    }

    const next = await this.activation.activateFrom(instance, step.stepIndex + 1);
    if (next.activeStepIndex === null) {
      await this.lifecycle.terminate(instance, 'approved', now);
      return ok({
        instanceId: instance.id,
        instanceStatus: 'approved',
        stepIndex: step.stepIndex,
        stepStatus: 'approved',
      });
    }

    const advanced = await this.instances.advance(instance.id, instance.version, {
      currentStepIndex: next.activeStepIndex,
      isStuck: next.stuck,
    });
    if (!advanced) return fail(approvalErrors.stepAlreadyDecided());

    return ok({
      instanceId: instance.id,
      instanceStatus: 'in_progress',
      stepIndex: step.stepIndex,
      stepStatus: 'approved',
    });
  }
}
