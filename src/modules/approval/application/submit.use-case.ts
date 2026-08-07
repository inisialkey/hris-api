import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { approvalErrors } from '../domain/approval.errors';
import {
  ACTION_REPOSITORY,
  APPROVAL_DIRECTORY,
  CHAIN_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ActionRepositoryPort,
  type ApprovalDirectoryPort,
  type ChainRepositoryPort,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
  type SubmitCommand,
} from '../domain/approval.ports';
import type { ChainSnapshot, InstanceRow } from '../domain/approval.types';
import { selectChain } from '../domain/chain-selection';
import { ActivationService } from './activation.service';
import { InstanceLifecycleService } from './lifecycle.service';

/**
 * UC-APRV-001 — the module's entry point, and the transaction it runs in is the
 * module's own (§9: *"port call is same-tx — rollback removes instance rows
 * atomically"*).
 */
@Injectable()
export class SubmitUseCase {
  constructor(
    @Inject(CHAIN_REPOSITORY) private readonly chains: ChainRepositoryPort,
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
    private readonly activation: ActivationService,
    private readonly lifecycle: InstanceLifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async submit(cmd: SubmitCommand): Promise<Result<{ instanceId: string }>> {
    /**
     * The requester's company comes from `employee_directory`, **not** from
     * `context.companyId`. Every registry entry in §13 carries one, but context
     * is what the module chose to send and the chain scope is what the engine
     * has to be right about — a wrong company here silently selects another
     * company's approvers. The view is the authority on where somebody works.
     */
    const requester = await this.directory.byEmployeeId(cmd.requesterEmployeeId);
    if (!requester) return fail(sharedErrors.notFound());
    if (!requester.userId) {
      // A requester with no login cannot be returned to, cannot cancel, and
      // cannot see the outcome — and `requester_user_id` is NOT NULL for those
      // reasons. It is a module precondition rather than a user-facing state.
      throw new Error(`employee ${cmd.requesterEmployeeId} has no user account to submit as`);
    }

    const candidates = await this.chains.selectable(cmd.requestType, requester.companyId);
    const chain = selectChain(candidates, requester.companyId, cmd.context);
    if (!chain) return fail(approvalErrors.noChainConfigured({ requestType: cmd.requestType }));

    const snapshot: ChainSnapshot = {
      chainId: chain.id,
      name: chain.name,
      priority: chain.priority,
      steps: chain.steps,
    };

    const instance = await this.create(cmd, requester.companyId, requester.userId, snapshot);
    if (!instance.ok) return instance;

    await this.steps.createAll(instance.value.id, snapshot.steps);
    await this.actions.append({
      instanceId: instance.value.id,
      actorUserId: requester.userId,
      action: 'submit',
    });

    const activated = await this.activation.activateFrom(instance.value, 0);
    if (activated.activeStepIndex === null) {
      // A chain whose every step skipped. Rare and legal — `onVacancy: skip` on
      // a single-step chain with a vacant position is exactly it — and the
      // request is approved, because no approver was required at any step. It
      // goes through the lifecycle service so the terminal event fires: the
      // module is holding a request that was just decided without a human.
      await this.lifecycle.terminate(instance.value, 'approved', this.clock.now());
    } else if (activated.activeStepIndex !== 0 || activated.stuck) {
      await this.instances.advance(instance.value.id, instance.value.version, {
        currentStepIndex: activated.activeStepIndex,
        isStuck: activated.stuck,
      });
    }

    return ok({ instanceId: instance.value.id });
  }

  /**
   * BR-APRV-005's live-uniqueness is a **constraint**, not a pre-check: two
   * submits of one request in the same instant is precisely the race
   * `uq_approval_instances_live` exists to lose gracefully, and a `SELECT` first
   * would only narrow the window. §14 says the module surfaces the conflict, and
   * `VAL_DUPLICATE` on `requestId` is what a module that did not pre-check gets.
   */
  private async create(
    cmd: SubmitCommand,
    companyId: string,
    requesterUserId: string,
    chainSnapshot: ChainSnapshot,
  ): Promise<Result<InstanceRow>> {
    try {
      return ok(
        await this.instances.create({
          companyId,
          requestType: cmd.requestType,
          requestId: cmd.requestId,
          requesterEmployeeId: cmd.requesterEmployeeId,
          requesterUserId,
          chainSnapshot,
          context: cmd.context,
        }),
      );
    } catch (error) {
      const violation = error as { code?: string; constraint?: string } | null;
      if (violation?.code === '23505' && violation.constraint === 'uq_approval_instances_live') {
        return fail(
          sharedErrors.validationFailed([
            {
              field: 'requestId',
              code: fieldCodes.duplicate,
              messageKey: `errors.${fieldCodes.duplicate}`,
              params: { field: 'requestId' },
            },
          ]),
        );
      }
      throw error;
    }
  }
}
