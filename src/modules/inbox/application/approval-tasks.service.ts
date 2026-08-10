import { Inject, Injectable, Logger } from '@nestjs/common';

import { APPROVAL_TASK_PORT, type ApprovalStepTasks, type ApprovalTaskPort } from '../../approval';
import {
  INBOX_REPOSITORY,
  type InboxRepositoryPort,
  type NewInboxItem,
} from '../domain/inbox.ports';
import type { ClosedReason, TitleParams } from '../domain/inbox.types';
import { DEFAULT_LOCALE } from '../domain/locale';
import { renderTitle, titleFor } from '../domain/titles';

/** §12's four terminal handler jobs, mapped to §4's `closed_reason` vocabulary. */
export const TERMINAL_REASONS = {
  approved: 'instance_approved',
  rejected: 'instance_rejected',
  returned: 'instance_returned',
  cancelled: 'instance_cancelled',
} as const satisfies Record<string, ClosedReason>;

export type TerminalOutcome = keyof typeof TERMINAL_REASONS;

/**
 * UC-INB-001 and UC-INB-002 — the approval half of the task list.
 *
 * Everything here is driven by a §12 event and nothing by a request, which is
 * why there is no `Result` in the file: a handler has no user to answer and its
 * only two outcomes are "converged" and "throw, and let the relay retry".
 *
 * **The engine is read through its port, never its tables.** approval-engine
 * §13 used to describe items as deriving from *"live `approval_assignees`
 * rows"*; `ApprovalTaskPort.stepTasks` is what that sentence should always have
 * said, and A-199 (hris-handbook PR #33) is where it now does.
 */
@Injectable()
export class ApprovalTasksService {
  private readonly logger = new Logger(ApprovalTasksService.name);

  constructor(
    @Inject(INBOX_REPOSITORY) private readonly items: InboxRepositoryPort,
    @Inject(APPROVAL_TASK_PORT) private readonly tasks: ApprovalTaskPort,
  ) {}

  /**
   * UC-INB-001 — one item per assignee of a freshly activated step.
   *
   * Idempotent by `uq_inbox_items_dedupe` on the assignee row id (BR-INB-004),
   * so a redelivered `on.approval.step.activated` inserts nothing. Returns how
   * many were new.
   */
  async materialize(stepId: string): Promise<number> {
    const step = await this.tasks.stepTasks(stepId);
    if (!step) {
      // A step that no longer exists is not an error the relay can retry away.
      // Loud, and not a throw: BR-INB-001 makes the inbox a navigation layer, so
      // the missing item costs a nudge and never a decision.
      this.logger.error(`inbox materialization found no approval step ${stepId}`);
      return 0;
    }
    if (step.tasks.length === 0) {
      // BR-APRV-006's stuck step: activated with zero assignees. There is nobody
      // to give a task to, and the engine has already flagged the instance.
      return 0;
    }

    return this.items.insertIfNew(this.itemsFor(step));
  }

  /**
   * BR-INB-006's precise completion — *"the actor's own item flips `done` on
   * `approval.assignee.acted`"*, including a partial `all`-quorum approval that
   * leaves the step active. The event carries the **assignee row id**, which is
   * the dedupe key, so this is one hit on the unique index.
   */
  completeActor(userId: string, assigneeId: string, at: Date): Promise<number> {
    return this.items.completeByDedupeKey(userId, assigneeId, at);
  }

  /**
   * BR-INB-006's sibling closure. Only the losers of an `any`-quorum step are
   * still `open` when this runs — the actor's own item went `done` on its own
   * event — so `superseded` is the reason for every row this touches.
   */
  closeSiblings(instanceId: string, stepId: string): Promise<number> {
    return this.items.closeApprovalItems(instanceId, stepId, 'superseded');
  }

  /** UC-INB-002's terminal closure — every remaining open item of the instance. */
  closeInstance(instanceId: string, outcome: TerminalOutcome): Promise<number> {
    return this.items.closeApprovalItems(instanceId, null, TERMINAL_REASONS[outcome]);
  }

  private itemsFor(step: ApprovalStepTasks): NewInboxItem[] {
    const template = titleFor(step.requestType);
    const titleParams: TitleParams = {
      ...scalars(step.context),
      ...(step.requesterName === null ? {} : { requesterName: step.requesterName }),
    };

    // Rendered once for the whole step, not once per seat: BR-INB-005 freezes
    // the title at creation and the sentence describes the *request*, which is
    // the same request for everybody sitting on the step. The delegate badge is
    // §7's own field rather than part of the sentence, so it varies below
    // without the title having to.
    const rendered = template
      ? renderTitle(template, DEFAULT_LOCALE, titleParams)
      : {
          title: [step.requestType, step.requesterName].filter(Boolean).join(' · '),
          subtitle: null,
          unresolved: [],
        };

    if (!template) {
      // Unreachable for every type approval-engine §13 registers — a test
      // asserts it — and kept because a type added there without copy here
      // would otherwise ship a blank task rather than a legible fallback.
      this.logger.warn(`inbox has no title template for request type ${step.requestType}`);
    }
    if (rendered.unresolved.length > 0) {
      // Names only. The values are a module's declared context fields and a task
      // title is content; security-standards §10 keeps content out of logs.
      this.logger.warn(
        `inbox title for ${step.requestType} left ${rendered.unresolved.join(', ')} unresolved`,
      );
    }

    return step.tasks.map((task) => ({
      userId: task.userId,
      type: 'approval_task' as const,
      dedupeKey: task.assigneeId,
      title: rendered.title,
      subtitle: rendered.subtitle,
      // UC-INB-001 — *"delegate items carry the delegate as `user_id` with the
      // original in `params`"*.
      params: {
        ...titleParams,
        ...(task.delegateOfUserId === null ? {} : { delegateOfUserId: task.delegateOfUserId }),
        ...(task.delegateOfName === null ? {} : { delegateOfName: task.delegateOfName }),
      },
      sourceRef: {
        instanceId: step.instanceId,
        stepId: step.stepId,
        assigneeId: task.assigneeId,
        requestType: step.requestType,
        requestId: step.requestId,
      },
      // No route grammar exists anywhere in the handbook: BR-NTF-011 cites
      // mobile-flutter §7 and §7 is the sync-engine seam (A-198, unchanged).
      // `deep_link` is `NOT NULL` here, so a nullable column's honest answer —
      // record the absence — is unavailable, and this is the next-honest one: a
      // *reference* built from the two ids `source_ref` already fixes, carrying
      // no invented screen or route name for mobile to have to already agree
      // with. A grammar arriving later maps this pair; nothing stored is wrong.
      deepLink: `${step.requestType}/${step.requestId}`,
      dueAt: step.dueAt,
    }));
  }
}

/**
 * The context fields a title may interpolate. Only primitives survive: the
 * column is jsonb and a nested object would render as `[object Object]`, while
 * `REQUEST_TYPE_CONTEXT_FIELDS` declares scalars anyway.
 */
function scalars(context: Record<string, unknown>): TitleParams {
  const out: TitleParams = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}
