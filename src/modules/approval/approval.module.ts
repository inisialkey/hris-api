import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuditModule, registerAuditedTables } from '../audit';
import { AuthzModule } from '../authz';
import { OrganizationModule } from '../organization';
import { SettingsModule } from '../settings';
import { ActivationService } from './application/activation.service';
import { ApprovalService } from './application/approval.service';
import { ApprovalTaskService } from './application/approval-task.service';
import { ChainService } from './application/chain.service';
import { DecideUseCase } from './application/decide.use-case';
import { DelegationService } from './application/delegation.service';
import { InstanceQueryService } from './application/instance-query.service';
import { InstanceLifecycleService } from './application/lifecycle.service';
import { SlaScanService } from './application/sla-scan.service';
import { SubmitUseCase } from './application/submit.use-case';
import { approvalErrorStatus } from './domain/approval.errors';
import {
  ACTION_REPOSITORY,
  APPROVAL_DIRECTORY,
  APPROVAL_OUTBOX,
  APPROVAL_PORT,
  APPROVAL_TASK_PORT,
  ASSIGNEE_REPOSITORY,
  CHAIN_REPOSITORY,
  DELEGATION_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
} from './domain/approval.ports';
import { ActionRepository } from './infrastructure/action.repository';
import { AssigneeRepository } from './infrastructure/assignee.repository';
import { ChainRepository } from './infrastructure/chain.repository';
import { DelegationRepository } from './infrastructure/delegation.repository';
import { ApprovalDirectoryRepository } from './infrastructure/directory.repository';
import { InstanceRepository } from './infrastructure/instance.repository';
import { StepRepository } from './infrastructure/step.repository';
import { ApprovalChainsController } from './presentation/chains.controller';
import { ApprovalDelegationsController } from './presentation/delegations.controller';
import { ApprovalInstancesController } from './presentation/instances.controller';

registerErrorStatuses(approvalErrorStatus);

/**
 * Channel-1 registration for the engine's **configuration**, and the two tables
 * that are deliberately absent from it.
 *
 * `approval_instances`, `approval_steps`, `approval_assignees` and
 * `approval_actions` stay out by BR-AUD-004: the action trail is the
 * authoritative approval record, and a channel-1 diff of every claim and every
 * step transition would be a second copy of it. Audit consumes the terminal
 * events instead (audit-log §12).
 *
 * `approval_chains` and `approval_delegations` are the other thing. A chain
 * decides who approves a payroll run and a delegation hands that authority to
 * somebody else — configuration, of the same class as a role grant, and
 * audit-log §4.2 carried no `approval_*` row at all (A-196, hris-handbook #30).
 */
registerAuditedTables({
  approval_chains: {},
  approval_delegations: {},
});

/**
 * Spine order 4. `ApprovalPort` is declared by nine module documents and eight
 * request types are registered for V1 — none of which exist yet, which is why
 * this module ships with **no consumer and a complete port**: every method's
 * correctness is defined by §5 and the `BR-APRV-*` rules and by nothing a caller
 * decides. That is the same line employee drew when it shipped `EmployeeHirePort`
 * and withheld `EmployeePayrollPort` (A-195).
 *
 * `SlaScanService` has no schedule for the reason the audit anchor and the
 * employee effectuate job have none: ADR-0010 puts crons on BullMQ and there is
 * no worker in this repository yet.
 */
@Module({
  imports: [AuditModule, AuthzModule, OrganizationModule, SettingsModule],
  controllers: [
    ApprovalChainsController,
    ApprovalInstancesController,
    ApprovalDelegationsController,
  ],
  providers: [
    SubmitUseCase,
    DecideUseCase,
    ActivationService,
    InstanceLifecycleService,
    ChainService,
    DelegationService,
    InstanceQueryService,
    SlaScanService,
    ApprovalService,
    ApprovalTaskService,

    { provide: APPROVAL_PORT, useExisting: ApprovalService },
    { provide: APPROVAL_TASK_PORT, useExisting: ApprovalTaskService },

    { provide: CHAIN_REPOSITORY, useClass: ChainRepository },
    { provide: INSTANCE_REPOSITORY, useClass: InstanceRepository },
    { provide: STEP_REPOSITORY, useClass: StepRepository },
    { provide: ASSIGNEE_REPOSITORY, useClass: AssigneeRepository },
    { provide: ACTION_REPOSITORY, useClass: ActionRepository },
    { provide: DELEGATION_REPOSITORY, useClass: DelegationRepository },
    { provide: APPROVAL_DIRECTORY, useClass: ApprovalDirectoryRepository },
    { provide: APPROVAL_OUTBOX, useExisting: OutboxRepository },
  ],
  exports: [APPROVAL_PORT, APPROVAL_TASK_PORT],
})
export class ApprovalModule {}
