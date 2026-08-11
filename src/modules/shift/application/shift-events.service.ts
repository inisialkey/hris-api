import { Inject, Injectable } from '@nestjs/common';

import { NOTIFICATION_PORT, type NotificationPort } from '../../notification';
import {
  EMPLOYEE_LOOKUP,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  type EmployeeLookupPort,
  type RosterDayRepositoryPort,
  type ScheduleCachePort,
} from '../domain/shift.ports';
import { WriteGuards } from './write-guards';

/** §13: the notification this module registers, in notification.md §4.2 since that session. */
export const ROSTER_CHANGED_TEMPLATE = 'shift.roster_changed';

/**
 * §12's four event handlers — **bodies, no schedule**.
 *
 * ADR-0010 dispatches from a BullMQ worker this repository does not have, so
 * these are the methods the relay will call and nothing calls them yet. That is
 * the same shape every other module here ships (A-199, A-200): the logic is
 * tested, the wiring arrives with the worker.
 *
 * This module owns **no jobs** (§12): resolve-on-read has nothing to generate and
 * nothing here decays on a schedule.
 */
@Injectable()
export class ShiftEventHandlers {
  constructor(
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    private readonly guards: WriteGuards,
  ) {}

  /**
   * `on.holiday.calendar.changed` — UC-SHF-009. Bust the affected buckets, and
   * **flag the explicit holiday-work days for review**: those rows still stand
   * (BR-SHF-004), so the grid has to show HR the deliberate holiday work its own
   * calendar edit just implied. Days without the flag simply resolve to `off` on
   * the next read; **no row is ever mutated**.
   */
  async onHolidayCalendarChanged(event: {
    tenantId: string;
    dates: string[];
  }): Promise<{ flagged: { employeeId: string; date: string }[] }> {
    await this.cache.bustTenant(event.tenantId);

    const flagged = (await this.rosterDays.flaggedOn(event.dates)).map((row) => ({
      employeeId: row.employeeId,
      date: row.date,
    }));
    return { flagged };
  }

  /**
   * `on.organization.assignment.changed` — a branch move changes the timezone the
   * same wall-clock shift resolves in, while the wall-clock roster itself is
   * unchanged. This discharges organization.md §12's forward duty for this module.
   */
  async onPlacementChanged(event: { tenantId: string; employeeId: string }): Promise<void> {
    await this.cache.bustEmployee(event.tenantId, event.employeeId);
  }

  /**
   * `on.employee.status.changed` — UC-SHF-010. A terminal status stops **nothing**
   * here by design: assignments and days stay as history, the resolver keeps
   * answering, and consumers stop asking. Deleting a schedule would erase the
   * reason a mid-month absence looks the way it does.
   */
  async onEmployeeStatusChanged(event: { tenantId: string; employeeId: string }): Promise<void> {
    await this.cache.bustEmployee(event.tenantId, event.employeeId);
  }

  /**
   * `on.shift.roster.changed` — §13's batching. One message per employee per
   * mutation batch, **future dates only**: a corrected past cell is bookkeeping,
   * a changed future shift is when you show up.
   */
  async onRosterChanged(event: {
    employeeIds: string[];
    dates: string[];
  }): Promise<{ notified: string[] }> {
    const today = this.guards.today();
    const future = event.dates.filter((date) => date > today).sort();
    if (future.length === 0 || event.employeeIds.length === 0) return { notified: [] };

    const employees = await this.employees.findMany(event.employeeIds);
    const notified: string[] = [];

    for (const employeeId of event.employeeIds) {
      // §13's audience is the affected employee, and notification addresses
      // people by login: somebody with no account has nowhere to be told.
      const userId = employees.get(employeeId)?.userId;
      if (!userId) continue;
      await this.notifications.send({
        templateKey: ROSTER_CHANGED_TEMPLATE,
        recipients: { kind: 'users', userIds: [userId] },
        params: { firstDate: future[0] ?? '', dateCount: future.length },
        // One message per employee per batch: the dedupe key names the batch's
        // own date span rather than the moment it was sent.
        dedupeKey: `${ROSTER_CHANGED_TEMPLATE}:${employeeId}:${future[0] ?? ''}:${future.length}`,
      });
      notified.push(employeeId);
    }
    return { notified };
  }
}
