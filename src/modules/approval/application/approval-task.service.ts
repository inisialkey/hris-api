import { Inject, Injectable } from '@nestjs/common';

import {
  APPROVAL_DIRECTORY,
  ASSIGNEE_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ApprovalDirectoryPort,
  type ApprovalStepTasks,
  type ApprovalTaskPort,
  type AssigneeRepositoryPort,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
} from '../domain/approval.ports';

const HOUR_MS = 60 * 60 * 1000;

/**
 * §7's `ApprovalTaskPort`, added for inbox.md (A-199, hris-handbook PR #33).
 *
 * Four reads and no writes. It exists so that the one consumer that needs a
 * step's seats *as tasks* does not read `approval_assignees` — the table
 * approval-engine §13 used to point at, and which ADR-0001 rule 2 has always
 * kept behind this boundary.
 */
@Injectable()
export class ApprovalTaskService implements ApprovalTaskPort {
  constructor(
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
  ) {}

  async stepTasks(stepId: string): Promise<ApprovalStepTasks | null> {
    const step = await this.steps.findById(stepId);
    if (!step) return null;

    const instance = await this.instances.findById(step.instanceId);
    if (!instance) return null;

    const seats = await this.assignees.listByStep(stepId);

    // One directory read for every name, never one per seat — the N+1
    // coding-standards-nestjs §5 calls a review blocker. The requester is in the
    // same batch because they are usually not one of the approvers and would
    // otherwise be a second round trip.
    const names = await this.directory.byUserIds([
      ...new Set(
        [instance.requesterUserId, ...seats.map((seat) => seat.delegateOfUserId)].filter(
          (value): value is string => value !== null,
        ),
      ),
    ]);

    return {
      instanceId: instance.id,
      stepId: step.id,
      requestType: instance.requestType,
      requestId: instance.requestId,
      requesterUserId: instance.requesterUserId,
      requesterName: names.get(instance.requesterUserId)?.fullName ?? null,
      context: instance.context,
      dueAt: dueAt(step.activatedAt, step.slaHours),
      // Every seat, whatever its status. A handler running after the step
      // decided still materializes the items its closure event is about to
      // close, which is the convergence BR-INB-004's idempotence promises and
      // BR-INB-001 permits — *"a stale item misleads nobody"*.
      tasks: seats.map((seat) => ({
        assigneeId: seat.id,
        userId: seat.approverUserId,
        delegateOfUserId: seat.delegateOfUserId,
        delegateOfName: seat.delegateOfUserId
          ? (names.get(seat.delegateOfUserId)?.fullName ?? null)
          : null,
      })),
    };
  }
}

/**
 * BR-INB-009's deadline, summed here rather than shipped as two fields: the sum
 * is what the inbox sorts and styles on, and `sla_hours` lives in the chain
 * snapshot this module owns. Calendar hours, per BR-APRV-010 — business-hours
 * clocks are that rule's own future note.
 */
function dueAt(activatedAt: Date | null, slaHours: number | null): Date | null {
  if (!activatedAt || slaHours === null) return null;
  return new Date(activatedAt.getTime() + slaHours * HOUR_MS);
}
