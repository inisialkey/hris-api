import { Module, type OnModuleInit } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { NeverLockedPeriods, PERIOD_LOCK_PORT } from '../../shared/period-lock.port';
import { AuditModule, registerAuditedTables } from '../audit';
import { AuthzModule } from '../authz';
import { ImportExportModule } from '../import-export';
import { OrganizationModule } from '../organization';
import { HolidayImportHandler, registerHolidayImport } from './application/holiday-import';
import { HolidayQueryService } from './application/holiday-query.service';
import { HolidayService } from './application/holiday.service';
import { SelfScopeService } from './application/self-scope.service';
import { holidayErrorStatus } from './domain/holiday.errors';
import {
  EMPLOYEE_SCOPE,
  HOLIDAY_CACHE,
  HOLIDAY_OUTBOX,
  HOLIDAY_QUERY_PORT,
  HOLIDAY_REPOSITORY,
} from './domain/holiday.ports';
import { EmployeeScopeRepository } from './infrastructure/employee-scope.repository';
import { HolidayCache } from './infrastructure/holiday-cache.service';
import { HolidayRepository } from './infrastructure/holiday.repository';
import { HolidaysController } from './presentation/holidays.controller';

registerErrorStatuses(holidayErrorStatus);

/**
 * BR-HOL-009 — `holidays` is audited channel 1 with full diffs, and was
 * audit-log §4.2's first registry entry. Nothing here is encrypted and nothing
 * is masked: a calendar row is the fact the trail exists to record.
 */
registerAuditedTables({ holidays: {} });

/**
 * The holiday module — one table, one reducer, one port.
 *
 * It is the first business module in this repository, and the reason it lands
 * before shift rather than beside it: `HolidayQueryPort` is what BR-SHF-004's
 * suppression asks, and a stub for it would put the answer in `shared/` while
 * the module that owns it was one file away from existing
 * (implementation-roadmap §4.3 builds holiday with the backbone).
 */
@Module({
  imports: [AuditModule, AuthzModule, OrganizationModule, ImportExportModule],
  controllers: [HolidaysController],
  providers: [
    HolidayService,
    HolidayQueryService,
    SelfScopeService,
    HolidayImportHandler,

    { provide: HOLIDAY_QUERY_PORT, useExisting: HolidayQueryService },
    { provide: HOLIDAY_REPOSITORY, useClass: HolidayRepository },
    { provide: EMPLOYEE_SCOPE, useClass: EmployeeScopeRepository },
    { provide: HOLIDAY_CACHE, useClass: HolidayCache },
    { provide: HOLIDAY_OUTBOX, useExisting: OutboxRepository },
    // The sanctioned stub (implementation-roadmap §4.3). attendance.md §4.2 owns
    // the real one; until it ships, every date is open.
    { provide: PERIOD_LOCK_PORT, useClass: NeverLockedPeriods },
  ],
  exports: [HOLIDAY_QUERY_PORT],
})
export class HolidayModule implements OnModuleInit {
  constructor(private readonly imports: HolidayImportHandler) {}

  /**
   * UC-HOL-004's definition, registered at init rather than at first use — a
   * definition key with nothing registered against it is not live (BR-IMP-001),
   * so registration is the gate rather than a decoration.
   */
  onModuleInit(): void {
    registerHolidayImport(this.imports);
  }
}
