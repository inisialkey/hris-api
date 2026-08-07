import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireTenantContext } from '../../../shared/context';
import { ORG_PLACEMENT_PORT, type OrgPlacementPort } from '../../organization';
import { ACCOUNT_LIFECYCLE_PORT, type AccountLifecyclePort } from '../../auth';
import {
  EMPLOYEE_OUTBOX,
  EMPLOYEE_REPOSITORY,
  type EmployeeOutboxPort,
  type EmployeeRepositoryPort,
  STATUS_HISTORY_REPOSITORY,
  type StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { StatusHistoryRow } from '../domain/employee.types';
import { isTerminal } from '../domain/status-machine';

/**
 * UC-EMP-007 and BR-EMP-006's side-effect set, in one place because two callers
 * need it: the daily effectuate scan, and a termination whose effective date is
 * today (UC-EMP-006 applies that one inline rather than making an admin wait a
 * day for a decision they just took).
 *
 * A **domain service rather than a shared use case** — coding-standards-nestjs
 * §2: a use case never injects another use case, and same-module composition is
 * exactly this.
 *
 * **The claim happens before the effects.** `markApplied` is guarded by
 * `applied_at IS NULL`, so it is an atomic claim rather than a stamp: two
 * runners serialize on the row lock and the loser does nothing. Ordering it
 * afterwards would leave a crashed run's side effects to be repeated, and one
 * of them — the outbox event — is not idempotent, because a second emit is a
 * second `eventId` and every consumer's dedup guard is keyed on that.
 */
@Injectable()
export class EffectuateService {
  private readonly log = new Logger(EffectuateService.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(STATUS_HISTORY_REPOSITORY) private readonly history: StatusHistoryRepositoryPort,
    @Inject(ORG_PLACEMENT_PORT) private readonly placement: OrgPlacementPort,
    @Inject(ACCOUNT_LIFECYCLE_PORT) private readonly accounts: AccountLifecyclePort,
    @Inject(EMPLOYEE_OUTBOX) private readonly outbox: EmployeeOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The scan. **Effective-date order is load-bearing**: an employee can hold a
   * scheduled `on_leave` and a scheduled `resigned` at once, and applying them
   * newest-first would leave the status reading `on_leave` after the person had
   * gone. The repository orders them; this only walks the list.
   */
  async runDue(onOrBefore: string): Promise<number> {
    const rows = await this.history.due(onOrBefore);
    let applied = 0;
    for (const row of rows) {
      if (await this.apply(row)) applied += 1;
    }
    return applied;
  }

  async apply(row: StatusHistoryRow): Promise<boolean> {
    const claimed = await this.history.markApplied(row.id, this.clock.now());
    if (!claimed) return false;

    const employee = await this.employees.findById(row.employeeId);
    if (!employee) {
      // A soft-deleted employee with a scheduled row. The claim stands — the
      // schedule is spent either way — and there is nothing left to transition.
      this.log.warn({ statusHistoryId: row.id }, 'effectuation found no live employee');
      return false;
    }

    await this.employees.setStatus(row.employeeId, row.status);

    if (isTerminal(row.status)) {
      await this.runExitEffects(row, employee.userId);
    }

    await this.outbox.emit({
      name: 'employee.status.changed',
      tenantId: requireTenantContext().tenantId,
      aggregateId: row.employeeId,
      payload: {
        employeeId: row.employeeId,
        companyId: employee.companyId,
        status: row.status,
        effectiveDate: row.effectiveDate,
        source: row.source,
      },
    });

    return true;
  }

  /**
   * BR-EMP-006, minus one item. Pending data-change and resignation requests are
   * cancelled here in the handbook, and both tables belong to the approval
   * engine's arrival (spine order 4) — so the sweep lands with them rather than
   * being half-written against tables that do not exist. A-195 names it, and it
   * is the one clause of this rule the exit does not yet honour.
   */
  private async runExitEffects(row: StatusHistoryRow, userId: string | null): Promise<void> {
    const closed = await this.placement.closeOnExit(row.employeeId, row.effectiveDate);
    if (!closed.ok) {
      // The placement port refuses on a locked period. An exit that cannot close
      // its assignment must not half-apply: rolling the transaction back leaves
      // the schedule unclaimed for the next run, by which time the period is
      // either unlocked or a human has been told.
      throw new Error(`closeOnExit refused for ${row.employeeId}: ${closed.error.code}`);
    }

    if (userId) {
      // Login and refresh die immediately (BR-AUTH-002 liveness); access tokens
      // age out inside their 15-minute horizon.
      await this.accounts.deactivateUser(userId, `employee ${row.status}`);
    }
  }
}
