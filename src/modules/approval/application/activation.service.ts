import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { ROLE_HOLDER_PORT, type RoleHolderPort } from '../../authz';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import {
  ACTION_REPOSITORY,
  APPROVAL_OUTBOX,
  ASSIGNEE_REPOSITORY,
  DELEGATION_REPOSITORY,
  STEP_REPOSITORY,
  type ActionRepositoryPort,
  type ApprovalOutboxPort,
  type AssigneeRepositoryPort,
  type DelegationRepositoryPort,
  type StepRepositoryPort,
} from '../domain/approval.ports';
import type { InstanceRow, Resolver, StepConfig, StepRow } from '../domain/approval.types';
import { applySelfApproval, redirectDelegations, type Assignment } from '../domain/resolution';

/** BR-APRV-006's last rung — the tenant-configured role, HR Admin by default. */
const FALLBACK_ROLE_KEY = 'approval.fallback_role';

export interface ActivationOutcome {
  /** `null` = every remaining step skipped, so the instance is approved. */
  activeStepIndex: number | null;
  stuck: boolean;
}

/**
 * BR-APRV-006, BR-APRV-007 and BR-APRV-009 in one place, because they are one
 * act: *"approver resolution happens at step activation, not submission"*.
 *
 * The ordering below is the rule and not an implementation preference:
 *
 * 1. Resolve the step's resolvers (union).
 * 2. Nobody? The **vacancy ladder** — `skip`, a fallback resolver, or the
 *    fallback role.
 * 3. The **self-approval guard** over whatever survived, which can skip the step
 *    or send it one level up.
 * 4. The **delegation redirect**, exactly once.
 * 5. Still nobody? The step stays `active` with zero assignees and the instance
 *    is flagged **stuck** — never silently skipped past the last rung.
 *
 * A reroute that finds nobody falls back into step 2 rather than into a new
 * path, which is what keeps this terminating without an invented depth cap:
 * BR-APRV-007 says *next* level, singular, and "nobody up there either" is the
 * vacancy the ladder already answers.
 */
@Injectable()
export class ActivationService {
  constructor(
    @Inject(STEP_REPOSITORY) private readonly steps: StepRepositoryPort,
    @Inject(ASSIGNEE_REPOSITORY) private readonly assignees: AssigneeRepositoryPort,
    @Inject(ACTION_REPOSITORY) private readonly actions: ActionRepositoryPort,
    @Inject(DELEGATION_REPOSITORY) private readonly delegations: DelegationRepositoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(ROLE_HOLDER_PORT) private readonly roles: RoleHolderPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
    @Inject(APPROVAL_OUTBOX) private readonly outbox: ApprovalOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Activates the first step at or after `fromIndex` that yields an approver,
   * skipping the ones the guard and the ladder decide away.
   *
   * The loop is the reason this is not "activate step N": a chain whose first
   * two steps both skip has to reach the third in the same transaction, or the
   * instance would sit `in_progress` with no active step and nothing to wake it.
   */
  async activateFrom(instance: InstanceRow, fromIndex: number): Promise<ActivationOutcome> {
    const configs = instance.chainSnapshot.steps;

    for (let index = fromIndex; index < configs.length; index += 1) {
      const step = await this.steps.findByIndex(instance.id, index);
      const config = configs[index];
      if (!step || !config) continue;

      const assignments = await this.resolve(instance, config);

      if (assignments === 'skip') {
        await this.steps.decide(step.id, step.version, 'skipped', this.clock.now());
        await this.actions.append({
          instanceId: instance.id,
          stepId: step.id,
          action: 'skipped',
        });
        continue;
      }

      await this.open(instance, step, assignments);
      return { activeStepIndex: index, stuck: assignments.length === 0 };
    }

    return { activeStepIndex: null, stuck: false };
  }

  /** Writes the seats, moves the step to `active`, and fans the event out. */
  private async open(
    instance: InstanceRow,
    step: StepRow,
    assignments: readonly Assignment[],
  ): Promise<void> {
    const now = this.clock.now();
    await this.steps.activate(step.id, step.version, now);
    await this.assignees.createAll(step.id, assignments);

    // An empty `assigneeUserIds` **is** the stuck signal, and §12 registers no
    // separate event for it. The notification module reads the same payload for
    // both templates — a step nobody was assigned is the "stuck instance to
    // System Administrator" case (§13), and `is_stuck` is its queryable half.
    await this.outbox.emit({
      name: 'approval.step.activated',
      tenantId: requireTenantContext().tenantId,
      aggregateId: instance.id,
      payload: {
        instanceId: instance.id,
        stepId: step.id,
        assigneeUserIds: assignments.map((assignment) => assignment.approverUserId),
      },
    });
  }

  /** `'skip'` = the step is decided without an approver (ladder or guard). */
  private async resolve(instance: InstanceRow, config: StepConfig): Promise<Assignment[] | 'skip'> {
    const asOf = this.today();
    let users = await this.resolveAll(instance, config.resolvers, asOf);

    if (users.length === 0) {
      const ladder = await this.vacancyLadder(instance, config, asOf);
      if (ladder === 'skip') return 'skip';
      users = ladder;
    }

    const guard = applySelfApproval(users, instance.requesterUserId, config.onSelfApproval);
    if (guard.kind === 'skip') return 'skip';

    if (guard.kind === 'reroute') {
      users = await this.rerouteUp(instance, config, asOf);
      if (users.length === 0) {
        const ladder = await this.vacancyLadder(instance, config, asOf);
        if (ladder === 'skip') return 'skip';
        users = ladder;
      }
    } else {
      users = guard.users;
    }

    const live = await this.delegations.liveFor(users, asOf);
    const assignments = redirectDelegations(users, live, instance.requestType, asOf);

    // The redirect runs after the guard, so a delegation pointing back at the
    // requester would hand them their own request. Drop them again — the guard's
    // decision was "not this person", and a delegation is not an override of it.
    return config.onSelfApproval === 'allow'
      ? assignments
      : assignments.filter((assignment) => assignment.approverUserId !== instance.requesterUserId);
  }

  /**
   * BR-APRV-007's *next* level. The base is the deepest `direct_manager` the step
   * already asked for, so a step configured at level 2 reroutes to 3 rather than
   * back to 1; a step with no manager resolver at all reroutes to the requester's
   * own manager.
   */
  private async rerouteUp(
    instance: InstanceRow,
    config: StepConfig,
    asOf: string,
  ): Promise<string[]> {
    const base = config.resolvers.reduce(
      (deepest, resolver) =>
        resolver.type === 'direct_manager' ? Math.max(deepest, resolver.levels) : deepest,
      0,
    );
    const users = await this.org.directManagers(instance.requesterEmployeeId, base + 1, asOf);
    const others = users.filter((userId) => userId !== instance.requesterUserId);

    if (others.length > 0) {
      await this.actions.append({
        instanceId: instance.id,
        action: 'rerouted',
        comment: `self-approval guard: level ${base + 1}`,
      });
    }
    return others;
  }

  private async vacancyLadder(
    instance: InstanceRow,
    config: StepConfig,
    asOf: string,
  ): Promise<string[] | 'skip'> {
    if (config.onVacancy.policy === 'skip') return 'skip';

    if (config.onVacancy.policy === 'fallback_resolver') {
      return this.resolveAll(instance, [config.onVacancy.resolver], asOf);
    }

    const key = await this.settings.resolve<string>(FALLBACK_ROLE_KEY, {
      companyId: instance.companyId,
    });
    const roleId = await this.roles.findIdByKey(key);
    return roleId ? this.roles.holderUserIds(roleId, instance.companyId) : [];
  }

  /**
   * The union §4 asks for. Sequential, never `Promise.all`: this runs inside the
   * caller's unit of work and one transaction is one `pg` socket
   * (coding-standards-nestjs §4).
   */
  private async resolveAll(
    instance: InstanceRow,
    resolvers: readonly Resolver[],
    asOf: string,
  ): Promise<string[]> {
    const users = new Set<string>();
    for (const resolver of resolvers) {
      for (const userId of await this.resolveOne(instance, resolver, asOf)) {
        users.add(userId);
      }
    }
    return [...users];
  }

  private async resolveOne(
    instance: InstanceRow,
    resolver: Resolver,
    asOf: string,
  ): Promise<string[]> {
    switch (resolver.type) {
      case 'direct_manager':
        return this.org.directManagers(instance.requesterEmployeeId, resolver.levels, asOf);
      case 'position_holder':
        return this.org.positionHolders(resolver.positionId, asOf);
      case 'role_holders':
        // "Scoped to requester's company" (ADR-0008) — the instance froze that
        // company at submit, so a transfer mid-flight does not move the chain.
        return this.roles.holderUserIds(resolver.roleId, instance.companyId);
      default:
        return [resolver.userId];
    }
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}
