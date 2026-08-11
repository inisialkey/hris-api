import { Module, type OnModuleInit } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { NeverLockedPeriods, PERIOD_LOCK_PORT } from '../../shared/period-lock.port';
import { AuditModule, registerAuditedTables } from '../audit';
import { AuthzModule } from '../authz';
import { HolidayModule } from '../holiday';
import { ImportExportModule } from '../import-export';
import { NotificationModule } from '../notification';
import { OrganizationModule } from '../organization';
import { MyScheduleService } from './application/me-schedule.service';
import { PatternService } from './application/pattern.service';
import { RosterAssignmentService } from './application/roster-assignment.service';
import { RosterDayService } from './application/roster-day.service';
import { RosterGridService } from './application/roster-grid.service';
import { ScheduleQueryService } from './application/schedule-query.service';
import { ShiftDefinitionService } from './application/shift-definition.service';
import { ShiftEventHandlers } from './application/shift-events.service';
import { ShiftImportHandler, registerShiftImport } from './application/shift-import';
import { WriteGuards } from './application/write-guards';
import { shiftErrorStatus } from './domain/shift.errors';
import {
  ASSIGNMENT_REPOSITORY,
  EMPLOYEE_LOOKUP,
  PATTERN_REPOSITORY,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_QUERY_PORT,
  SHIFT_REPOSITORY,
} from './domain/shift.ports';
import { EmployeeLookupRepository } from './infrastructure/employee-lookup.repository';
import { PatternRepository } from './infrastructure/pattern.repository';
import { RosterAssignmentRepository } from './infrastructure/roster-assignment.repository';
import { RosterDayRepository } from './infrastructure/roster-day.repository';
import { ScheduleCache } from './infrastructure/schedule-cache.service';
import { ShiftRepository } from './infrastructure/shift.repository';
import {
  MyScheduleController,
  RosterAssignmentsController,
  RosterDaysController,
} from './presentation/roster.controller';
import { ShiftPatternsController, ShiftsController } from './presentation/shifts.controller';

registerErrorStatuses(shiftErrorStatus);

/**
 * BR-SHF-013 — all five tables are channel-1 audited with full diffs, and a bulk
 * roster import therefore writes one audit row per changed day, bounded by
 * `import-export.max_rows`. No sensitive columns anywhere here: a schedule is the
 * fact the trail exists to record.
 */
registerAuditedTables({
  shifts: {},
  shift_patterns: {},
  shift_pattern_days: {},
  roster_assignments: {},
  roster_days: {},
});

/**
 * The shift module — configuration only, resolved on read (§1).
 *
 * `ShiftQueryPort` is the whole outward surface: attendance asks it per punch and
 * per derivation day, overtime takes its baseline from `endAt`, leave counts
 * working days by `kind`, and payroll reads paid minutes through attendance's
 * derived day rather than from here. Nothing else leaves, and no module joins
 * these five tables.
 */
@Module({
  imports: [
    AuditModule,
    AuthzModule,
    OrganizationModule,
    HolidayModule,
    NotificationModule,
    ImportExportModule,
  ],
  controllers: [
    ShiftsController,
    ShiftPatternsController,
    RosterAssignmentsController,
    RosterDaysController,
    MyScheduleController,
  ],
  providers: [
    ScheduleQueryService,
    ShiftDefinitionService,
    PatternService,
    RosterAssignmentService,
    RosterDayService,
    RosterGridService,
    MyScheduleService,
    ShiftImportHandler,
    ShiftEventHandlers,
    WriteGuards,

    { provide: SHIFT_QUERY_PORT, useExisting: ScheduleQueryService },

    { provide: SHIFT_REPOSITORY, useClass: ShiftRepository },
    { provide: PATTERN_REPOSITORY, useClass: PatternRepository },
    { provide: ASSIGNMENT_REPOSITORY, useClass: RosterAssignmentRepository },
    { provide: ROSTER_DAY_REPOSITORY, useClass: RosterDayRepository },
    { provide: EMPLOYEE_LOOKUP, useClass: EmployeeLookupRepository },
    { provide: SCHEDULE_CACHE, useClass: ScheduleCache },
    { provide: SHIFT_OUTBOX, useExisting: OutboxRepository },
    // The sanctioned stub (implementation-roadmap §4.3). attendance.md §4.2 owns
    // the real one; until it ships, every date is open.
    { provide: PERIOD_LOCK_PORT, useClass: NeverLockedPeriods },
  ],
  exports: [SHIFT_QUERY_PORT],
})
export class ShiftModule implements OnModuleInit {
  constructor(private readonly imports: ShiftImportHandler) {}

  /** BR-SHF-012's definition, registered at init — an unregistered key is not live. */
  onModuleInit(): void {
    registerShiftImport(this.imports);
  }
}
