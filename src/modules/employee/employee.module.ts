import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuditModule, registerAuditedTables } from '../audit';
import { AuthModule } from '../auth';
import { AuthzModule } from '../authz';
import { OrganizationModule } from '../organization';
import { ContractService } from './application/contract.service';
import { EffectuateService } from './application/effectuate.service';
import { EmployeeHireService } from './application/employee-hire.service';
import { EmployeeStatusService } from './application/employee-status.service';
import { EmployeeService } from './application/employee.service';
import { FamilyService } from './application/family.service';
import { HireUseCase } from './application/hire.use-case';
import { ProfileService } from './application/profile.service';
import { RevealService } from './application/reveal.service';
import { TerminateUseCase } from './application/terminate.use-case';
import { employeeErrorStatus } from './domain/employee.errors';
import {
  CONTRACT_REPOSITORY,
  DIRECTORY_READER,
  EMPLOYEE_HIRE_PORT,
  EMPLOYEE_NUMBER_COUNTER,
  EMPLOYEE_OUTBOX,
  EMPLOYEE_REPOSITORY,
  EMPLOYEE_STATUS_PORT,
  FAMILY_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
} from './domain/employee.ports';
import { ContractRepository } from './infrastructure/contract.repository';
import { DirectoryRepository } from './infrastructure/directory.repository';
import { EmployeeNumberCounter } from './infrastructure/employee-number.counter';
import { EmployeeRepository } from './infrastructure/employee.repository';
import { FamilyRepository } from './infrastructure/family.repository';
import { StatusHistoryRepository } from './infrastructure/status-history.repository';
import {
  EmployeeContractsController,
  EmployeeFamilyController,
} from './presentation/employee-subresources.controller';
import { EmployeesController } from './presentation/employees.controller';
import { MeController } from './presentation/me.controller';

registerErrorStatuses(employeeErrorStatus);

/**
 * BR-EMP-011's channel-1 registration, appended to audit-log §4.2 in the session
 * that introduced the tables.
 *
 * **`employees` is the first table in the system with a masking note**, and only
 * one column needs one. The ADR-0016 encrypted set masks by *column type*
 * (BR-AUD-005 layer 1), which is why NIK, NPWP, the BPJS numbers and the bank
 * fields are absent from this list and still never appear in a diff. `ptkp_status`
 * is the exception the layer cannot reach: ADR-0016 decision 1 leaves it
 * unencrypted on purpose — the tax engine reads it for every employee on every
 * run — so nothing about the schema would mask it, and §4.2 says so by name.
 *
 * `employee_status_history` is deliberately absent: BR-EMP-011 keeps it out
 * because the history rows *are* the trail, and auditing them would file a diff
 * of the evidence beside the evidence.
 */
registerAuditedTables({
  employees: { maskedColumns: ['ptkp_status'] },
  employee_contracts: {},
  employee_family_members: {},
});

/**
 * Employee is spine order 3 and behaves like platform: `EmployeeHirePort` has
 * five declared consumers and `EmployeeStatusPort` is the only writer of
 * BR-EMP-005's `active ↔ on_leave` half.
 *
 * `EmployeePayrollPort` is specified (§13) and **not built** — its methods need
 * machinery only a payroll run can shape, and it has no caller until then
 * (A-195).
 */
@Module({
  imports: [AuditModule, AuthzModule, AuthModule, OrganizationModule],
  controllers: [
    EmployeesController,
    EmployeeContractsController,
    EmployeeFamilyController,
    MeController,
  ],
  providers: [
    EmployeeService,
    HireUseCase,
    TerminateUseCase,
    EffectuateService,
    ContractService,
    FamilyService,
    ProfileService,
    RevealService,
    EmployeeStatusService,
    EmployeeHireService,

    { provide: EMPLOYEE_STATUS_PORT, useExisting: EmployeeStatusService },
    { provide: EMPLOYEE_HIRE_PORT, useExisting: EmployeeHireService },

    { provide: EMPLOYEE_REPOSITORY, useClass: EmployeeRepository },
    { provide: CONTRACT_REPOSITORY, useClass: ContractRepository },
    { provide: STATUS_HISTORY_REPOSITORY, useClass: StatusHistoryRepository },
    { provide: FAMILY_REPOSITORY, useClass: FamilyRepository },
    { provide: EMPLOYEE_NUMBER_COUNTER, useClass: EmployeeNumberCounter },
    { provide: DIRECTORY_READER, useClass: DirectoryRepository },
    { provide: EMPLOYEE_OUTBOX, useExisting: OutboxRepository },
  ],
  exports: [EMPLOYEE_STATUS_PORT, EMPLOYEE_HIRE_PORT],
})
export class EmployeeModule {}
