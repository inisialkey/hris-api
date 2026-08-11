import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { EMPLOYEE_LOOKUP, type EmployeeLookupPort } from '../domain/shift.ports';
import type { ScheduledDay } from '../domain/shift.types';
import { addDays } from '../domain/time';
import { ScheduleQueryService } from './schedule-query.service';

/** BR-SHF-014's platform-fixed window: today − 30 … today + 60 (A-021). */
export const WINDOW_BEFORE_DAYS = 30;
export const WINDOW_AFTER_DAYS = 60;

export interface MySchedule {
  days: ScheduledDay[];
  from: string;
  to: string;
  branchTimezone: string | null;
  generatedAt: string;
}

export interface TeamMemberSchedule {
  employeeId: string;
  fullName: string;
  positionTitle: string;
  schedule: ScheduledDay;
}

/**
 * UC-SHF-007 and UC-SHF-008 — the two self-service reads.
 *
 * The window is **platform-fixed, not tenant-tunable** (BR-SHF-014, §13's
 * settings note): a wider range is clamped rather than refused, because the
 * mobile mirror replaces its window wholesale and a client asking for more than
 * the mirror holds is asking for something the offline story cannot keep true.
 */
@Injectable()
export class MyScheduleService {
  constructor(
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly schedule: ScheduleQueryService,
  ) {}

  async mine(requested: { from?: string; to?: string }): Promise<Result<MySchedule>> {
    const employee = await this.self();
    if (!employee) return fail(sharedErrors.notFound());

    const today = this.today();
    const floor = addDays(today, -WINDOW_BEFORE_DAYS);
    const ceiling = addDays(today, WINDOW_AFTER_DAYS + 1); // exclusive

    const from = clamp(requested.from ?? floor, floor, ceiling);
    const to = clamp(requested.to ?? ceiling, from, ceiling);

    const placement = await this.org.placement(employee.employeeId, today);
    return ok({
      days: await this.schedule.scheduleRange(employee.employeeId, from, to),
      from,
      to,
      branchTimezone: placement?.branchTimezone ?? null,
      generatedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * UC-SHF-008 — the manager's day. Direct reports come from the org port's
   * inverse; a non-manager gets an empty list rather than a 403, because
   * "nobody reports to you" is an answer and not a refusal.
   */
  async team(date: string): Promise<Result<TeamMemberSchedule[]>> {
    const employee = await this.self();
    if (!employee) return fail(sharedErrors.notFound());

    const reports = await this.org.directReports(employee.employeeId, date);
    if (reports.length === 0) return ok([]);

    const summaries = await this.employees.findMany(reports);
    const placements = await this.org.placements(reports, date);
    const schedules = await this.schedule.scheduleForMany(reports, date);

    return ok(
      reports.flatMap((employeeId) => {
        const summary = summaries.get(employeeId);
        const day = schedules.get(employeeId);
        if (!summary || !day) return [];
        return [
          {
            employeeId,
            fullName: summary.fullName,
            positionTitle: placements.get(employeeId)?.positionTitle ?? '',
            schedule: day,
          },
        ];
      }),
    );
  }

  private async self() {
    const userId = requireRequestContext().userId;
    return userId ? this.employees.findByUserId(userId) : null;
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

function clamp(value: string, low: string, high: string): string {
  return value < low ? low : value > high ? high : value;
}
