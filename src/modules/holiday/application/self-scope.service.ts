import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext } from '../../../shared/context';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { EMPLOYEE_SCOPE, type EmployeeScopePort } from '../domain/holiday.ports';
import type { HolidayScope } from '../domain/holiday.types';

/**
 * "My employment scope" — §7's rule for `/resolved` when the caller is not an
 * admin, and for `/sync` always.
 *
 * Two reads, and the split is not incidental: the **company** is an employment
 * fact and comes from the directory view, while the **branch** is a placement
 * fact as-of today and comes from `OrgQueryPort` (organization owns it, and it
 * moves when the employee does — §9's branch-transfer case).
 */
@Injectable()
export class SelfScopeService {
  constructor(
    @Inject(EMPLOYEE_SCOPE) private readonly employees: EmployeeScopePort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Tenant-wide (`companyId: null`) when the caller holds no employee record. */
  async resolve(): Promise<HolidayScope> {
    const userId = requireRequestContext().userId;
    if (!userId) return { companyId: null, branchId: null };

    const employee = await this.employees.findByUserId(userId);
    if (!employee) return { companyId: null, branchId: null };

    const placement = await this.org.placement(employee.employeeId, this.today());
    return { companyId: employee.companyId, branchId: placement?.branchId ?? null };
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}
