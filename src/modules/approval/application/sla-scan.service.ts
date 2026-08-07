import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { ROLE_HOLDER_PORT, type RoleHolderPort } from '../../authz';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import {
  ACTION_REPOSITORY,
  APPROVAL_DIRECTORY,
  ASSIGNEE_REPOSITORY,
  INSTANCE_REPOSITORY,
  STEP_REPOSITORY,
  type ActionRepositoryPort,
  type ApprovalDirectoryPort,
  type AssigneeRepositoryPort,
  type InstanceRepositoryPort,
  type StepRepositoryPort,
} from '../domain/approval.ports';
import type { InstanceRow, StepRow } from '../domain/approval.types';
import { InstanceLifecycleService } from './lifecycle.service';

/** BR-APRV-010 — platform-fixed, not tenant policy: escalation is at 2 × SLA. */
const ESCALATION_MULTIPLIER = 2;

const FALLBACK_ROLE_KEY = 'approval.fallback_role';

export interface SlaScanReport {
  reminded: number;
  escalated: number;
}

/**
 * UC-APRV-007, the `cron.approval.sla-scan` job's body.
 *
 * **No schedule yet.** §12 asks for every 15 minutes and ADR-0010 puts crons on
 * BullMQ, which has no worker in this repository — the audit anchor and the
 * employee effectuate job are in the same position. The body is what has to be
 * right, and a scheduler is one decorator once the worker lands; a body written
 * later against a live queue is the part nobody can test.
 *
 * **Steps never auto-decide, ever** (BR-APRV-010, ADR-0008). Nothing in this
 * file writes a step status. It stamps, it appends trail rows, and it emits —
 * the instance stays pending and loudly visible, because a payroll-feeding
 * decision does not default.
 */
@Injectable()
export class SlaScanService {
  private readonly logger = new Logger(SlaScanService.name);

  constructor(
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(INSTANCE_REPOSITORY) private readonly instances: InstanceRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(ROLE_HOLDER_PORT) private readonly roles: RoleHolderPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    private readonly lifecycle: InstanceLifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Idempotent by the two stamp columns: a re-run of the same scan finds
   * `reminded_at` already set and moves on. That is what makes a retried job
   * safe and what makes the 15-minute cadence a floor rather than a promise.
   */
  async run(): Promise<SlaScanReport> {
    const now = this.clock.now();
    const due = await this.steps.dueForSla(now);
    const report: SlaScanReport = { reminded: 0, escalated: 0 };

    for (const step of due) {
      if (this.breached(step, now, ESCALATION_MULTIPLIER)) {
        await this.escalate(step, now);
        report.escalated += 1;
        continue;
      }
      if (step.remindedAt === null) {
        await this.remind(step, now);
        report.reminded += 1;
      }
    }
    return report;
  }

  /**
   * A step that crosses both thresholds between two scans escalates and is
   * stamped `reminded_at` in the same pass — the reminder is not re-sent later,
   * because a reminder after an escalation is a notification about a deadline
   * that has already been overtaken.
   */
  private async escalate(step: StepRow, now: Date): Promise<void> {
    const instance = await this.instances.findById(step.instanceId);
    if (!instance) return;

    const targets = await this.escalationTargets(step, instance);
    await this.steps.stamp(step.id, 'escalatedAt', now);
    if (step.remindedAt === null) await this.steps.stamp(step.id, 'remindedAt', now);

    await this.actions.append({ instanceId: instance.id, stepId: step.id, action: 'escalated' });
    await this.lifecycle.emit('approval.step.escalated', instance.id, {
      instanceId: instance.id,
      stepId: step.id,
      escalatedToUserIds: targets,
    });

    if (targets.length === 0) {
      // Loud rather than silent: nobody to escalate to means the ladder has run
      // out on an instance that is already late (§9's stuck case, one rung up).
      this.logger.warn(`approval step ${step.id} escalated with no target`);
    }
  }

  private async remind(step: StepRow, now: Date): Promise<void> {
    await this.steps.stamp(step.id, 'remindedAt', now);
    await this.actions.append({ instanceId: step.instanceId, stepId: step.id, action: 'reminded' });
    // §12 registers no reminder event; the notification module's `reminder`
    // template reads the stamp and the trail row, both written above.
  }

  /**
   * BR-APRV-010: *"escalation notice to each assignee's direct manager, or the
   * fallback role when no manager resolves"*. Per assignee, not per instance —
   * an `all`-quorum step with three approvers escalates up three reporting lines.
   */
  private async escalationTargets(step: StepRow, instance: InstanceRow): Promise<string[]> {
    const asOf = this.clock.now().toISOString().slice(0, 10);
    const seats = await this.assignees.listByStep(step.id);
    const targets = new Set<string>();

    for (const seat of seats.filter((row) => row.status === 'active')) {
      const employeeId = await this.directory.employeeIdOf(seat.approverUserId);
      if (!employeeId) continue;
      for (const managerId of await this.org.directManagers(employeeId, 1, asOf)) {
        targets.add(managerId);
      }
    }

    if (targets.size > 0) return [...targets];

    const key = await this.settings.resolve<string>(FALLBACK_ROLE_KEY, {
      companyId: instance.companyId,
    });
    const roleId = await this.roles.findIdByKey(key);
    return roleId ? this.roles.holderUserIds(roleId, instance.companyId) : [];
  }

  private breached(step: StepRow, now: Date, multiplier: number): boolean {
    if (step.slaHours === null || step.activatedAt === null) return false;
    const threshold = step.activatedAt.getTime() + step.slaHours * multiplier * 3_600_000;
    return threshold <= now.getTime();
  }
}
