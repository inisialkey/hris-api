import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '../../../shared/context';
import { companyScope, requireCompanyInScope } from '../../../shared/data-scope';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import {
  ACTION_REPOSITORY,
  APPROVAL_DIRECTORY,
  ASSIGNEE_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ActionRepositoryPort,
  type ApprovalDirectoryPort,
  type AssigneeRepositoryPort,
  type InstanceFilter,
  type InstanceRepositoryPort,
  type Page,
  type Paged,
  type StepRepositoryPort,
} from '../domain/approval.ports';
import type {
  InstanceListRow,
  InstanceRow,
  StepRow,
  TimelineAction,
  TimelineAssignee,
} from '../domain/approval.types';

export interface InstanceTimeline {
  instance: InstanceRow;
  steps: StepRow[];
  assignees: (TimelineAssignee & { stepIndex: number })[];
  actions: TimelineAction[];
  previousInstanceIds: string[];
}

/** §7's three reads. */
@Injectable()
export class InstanceQueryService {
  constructor(
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
  ) {}

  /** The oversight grid — `approval.instance.read`, company data scope. */
  async list(
    filter: Omit<InstanceFilter, 'companyIds'>,
    page: Page,
  ): Promise<Result<Paged<InstanceListRow>>> {
    if (filter.companyId) {
      const scoped = await requireCompanyInScope(filter.companyId);
      if (!scoped.ok) return scoped;
    }
    return ok(await this.instances.list({ ...filter, companyIds: await companyScope() }, page));
  }

  async byId(id: string, oversight: boolean): Promise<Result<InstanceTimeline>> {
    const instance = await this.instances.findById(id);
    return instance ? this.timeline(instance, oversight) : fail(sharedErrors.notFound());
  }

  async byRequest(
    requestType: string,
    requestId: string,
    oversight: boolean,
  ): Promise<Result<InstanceTimeline>> {
    const instance = await this.instances.findNewestForRequest(requestType, requestId);
    return instance ? this.timeline(instance, oversight) : fail(sharedErrors.notFound());
  }

  /**
   * BR-APRV-012's read set — *"requester, current+past assignees, oversight
   * readers"* — and **404 outside it**, never 403. This is the half of the rule
   * the act path does not have: reaching `ApprovalPort.approve` means the
   * module's permission gate already passed, while reaching this endpoint proves
   * nothing about a relationship to the instance, so hiding existence is the
   * correct answer (§7: "Outside the visibility set → 404").
   */
  private async timeline(
    instance: InstanceRow,
    oversight: boolean,
  ): Promise<Result<InstanceTimeline>> {
    // Relationship first, oversight second, and the order matters: an HR Admin
    // scoped to one company can be seated on another company's step by a
    // `specific_user` resolver, and checking their permission first would answer
    // 404 for the one instance they are required to act on.
    const userId = requireRequestContext().userId;
    const related =
      instance.requesterUserId === userId ||
      (userId !== undefined && (await this.assignees.hasSeatOnInstance(instance.id, userId)));

    if (!related) {
      const scoped = oversight ? await requireCompanyInScope(instance.companyId) : null;
      if (!scoped?.ok) return fail(sharedErrors.notFound());
    }

    const steps = await this.steps.listByInstance(instance.id);
    const assigneeRows = await this.assignees.listByInstance(instance.id);
    const actionRows = await this.actions.listByInstance(instance.id);
    const previousInstanceIds = await this.instances.previousInstanceIds(
      instance.requestType,
      instance.requestId,
      instance.id,
    );

    // One directory read for every name the timeline renders — assignees, the
    // people they act for, and the actors on the trail. A lookup per row would be
    // the N+1 coding-standards-nestjs §5 calls a review blocker.
    const names = await this.directory.byUserIds([
      ...new Set(
        [
          ...assigneeRows.flatMap((row) => [row.approverUserId, row.delegateOfUserId]),
          ...actionRows.map((row) => row.actorUserId),
        ].filter((value): value is string => value !== null),
      ),
    ]);

    return ok({
      instance,
      steps,
      assignees: assigneeRows.map((row) => ({
        ...row,
        name: names.get(row.approverUserId)?.fullName ?? null,
        delegateOfName: row.delegateOfUserId
          ? (names.get(row.delegateOfUserId)?.fullName ?? null)
          : null,
      })),
      actions: actionRows.map((row) => ({
        ...row,
        actorName: row.actorUserId ? (names.get(row.actorUserId)?.fullName ?? null) : null,
        stepIndex: steps.find((step) => step.id === row.stepId)?.stepIndex ?? null,
      })),
      previousInstanceIds,
    });
  }
}
