import type { InstanceTimeline } from '../application/instance-query.service';
import type { ChainRow, DelegationRow } from '../domain/approval.types';

/**
 * §7's response shapes. Mapping rather than returning rows because two fields
 * are **derived and not stored** — `stepCount` and `isDefault` — and a client
 * computing "is this the catch-all" from a null check would be a second place
 * BR-APRV-002's rule lives.
 */
export function toChainSummary(chain: ChainRow) {
  return {
    id: chain.id,
    requestType: chain.requestType,
    companyId: chain.companyId,
    name: chain.name,
    priority: chain.priority,
    isActive: chain.isActive,
    stepCount: chain.steps.length,
    isDefault: chain.conditions === null || chain.conditions.length === 0,
  };
}

export function toChainDetail(chain: ChainRow) {
  return { ...toChainSummary(chain), conditions: chain.conditions ?? [], steps: chain.steps };
}

export function toDelegation(row: DelegationRow) {
  return {
    id: row.id,
    delegatorUserId: row.delegatorUserId,
    delegateUserId: row.delegateUserId,
    requestTypes: row.requestTypes,
    startDate: row.startDate,
    endDate: row.endDate,
    revokedAt: row.revokedAt,
  };
}

/** §7's instance detail — steps carry their assignees, actions are flat and ordered. */
export function toInstanceDetail(timeline: InstanceTimeline) {
  const { instance, steps, assignees, actions, previousInstanceIds } = timeline;
  return {
    id: instance.id,
    requestType: instance.requestType,
    requestId: instance.requestId,
    status: instance.status,
    isStuck: instance.isStuck,
    context: instance.context,
    requester: {
      employeeId: instance.requesterEmployeeId,
      userId: instance.requesterUserId,
    },
    currentStepIndex: instance.currentStepIndex,
    createdAt: instance.createdAt,
    completedAt: instance.completedAt,
    previousInstanceIds,
    steps: steps.map((step) => ({
      stepIndex: step.stepIndex,
      name: step.name,
      quorum: step.quorum,
      status: step.status,
      slaHours: step.slaHours,
      activatedAt: step.activatedAt,
      remindedAt: step.remindedAt,
      escalatedAt: step.escalatedAt,
      assignees: assignees
        .filter((assignee) => assignee.stepIndex === step.stepIndex)
        .map((assignee) => ({
          userId: assignee.approverUserId,
          name: assignee.name,
          delegateOf: assignee.delegateOfUserId
            ? { userId: assignee.delegateOfUserId, name: assignee.delegateOfName }
            : null,
          status: assignee.status,
          actedAt: assignee.actedAt,
        })),
    })),
    actions: actions.map((action) => ({
      action: action.action,
      actorUserId: action.actorUserId,
      actorName: action.actorName,
      delegateOf: action.delegateOfUserId,
      comment: action.comment,
      stepIndex: action.stepIndex,
      createdAt: action.createdAt,
    })),
  };
}
