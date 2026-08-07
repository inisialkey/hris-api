import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { addDays, toBusinessDate } from '../domain/dates';
import {
  type EmployeeStatusPort,
  STATUS_HISTORY_REPOSITORY,
  type StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import { EffectuateService } from './effectuate.service';

/**
 * `EmployeeStatusPort` (§13) — the `active ↔ on_leave` half of BR-EMP-005, whose
 * only writer is leave.md.
 *
 * The port exists because that half of the machine has no admin surface at all:
 * §2 has no "set on leave" action and BR-EMP-005 says so outright — *"no manual
 * toggle in V1"*. A status that only a leave approval may move is a status no
 * controller should be able to move, which is why it is a port rather than a
 * route with a permission key nobody would hold.
 *
 * Both rows are scheduled rather than applied: leave approved today for next
 * month must not change the status today, and the effectuate job is what turns a
 * date into a transition. `to + 1 day` is the return, because `to` is the last
 * day of leave and the employee is back the day after.
 */
@Injectable()
export class EmployeeStatusService implements EmployeeStatusPort {
  constructor(
    @Inject(STATUS_HISTORY_REPOSITORY) private readonly history: StatusHistoryRepositoryPort,
    private readonly effectuate: EffectuateService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async scheduleLeaveStatus(
    employeeId: string,
    from: string,
    to: string,
    leaveRequestId: string,
  ): Promise<void> {
    await this.history.insert({
      employeeId,
      status: 'on_leave',
      source: 'leave',
      sourceId: leaveRequestId,
      effectiveDate: from,
    });
    await this.history.insert({
      employeeId,
      status: 'active',
      source: 'leave',
      sourceId: leaveRequestId,
      effectiveDate: addDays(to, 1),
    });
  }

  /**
   * §13's two halves. Cancelling a leave that has not started drops both
   * scheduled rows and the status never moves. Cancelling one already under way
   * cannot un-apply the `on_leave` row — the employee *was* on leave, and history
   * is not edited — so the return is **brought forward to today** as a new row
   * and applied immediately.
   *
   * The distinguishing test is the `on_leave` row's own `applied_at`, not the
   * date: a job that has not run yet leaves a due row unapplied, and reading the
   * calendar instead would reverse a status that was never set.
   */
  async cancelLeaveStatus(leaveRequestId: string): Promise<void> {
    const rows = await this.history.forSource(leaveRequestId);
    if (rows.length === 0) return;

    for (const row of rows.filter((row) => row.appliedAt === null)) {
      await this.history.cancel(row.id);
    }

    const started = rows.find((row) => row.status === 'on_leave')?.appliedAt !== null;
    const returned = rows.find((row) => row.status === 'active')?.appliedAt !== null;
    if (!started || returned) return;

    const employeeId = rows[0]?.employeeId;
    if (employeeId === undefined) return;

    const reversal = await this.history.insert({
      employeeId,
      status: 'active',
      source: 'leave',
      sourceId: leaveRequestId,
      effectiveDate: toBusinessDate(this.clock.now()),
    });
    await this.effectuate.apply(reversal);
  }
}
