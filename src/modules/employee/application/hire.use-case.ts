import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { blindIndex } from '../../../shared/crypto/encrypted-text';
import { TenantKeyService } from '../../../shared/crypto/tenant-key.service';
import { requireCompanyInScope } from '../../../shared/data-scope';
import { type Result, fail, ok } from '../../../shared/result';
import { ORG_PLACEMENT_PORT, type OrgPlacementPort } from '../../organization';
import { ACCOUNT_LIFECYCLE_PORT, type AccountLifecyclePort } from '../../auth';
import {
  CONTRACT_REPOSITORY,
  type ContractRepositoryPort,
  EMPLOYEE_NUMBER_COUNTER,
  EMPLOYEE_REPOSITORY,
  type EmployeeNumberCounterPort,
  type EmployeeRepositoryPort,
  STATUS_HISTORY_REPOSITORY,
  type StatusHistoryRepositoryPort,
} from '../domain/employee.ports';
import type { EmployeeCreateInput, EmployeeRow } from '../domain/employee.types';
import { duplicate, mapConstraintViolation, required } from './field-errors';

/**
 * UC-EMP-001 / BR-EMP-002 — **hire is atomic**.
 *
 * One transaction writes the employees row, the initial contract, the `hire`
 * status-history row, and the initial placement through `OrgPlacementPort`; the
 * optional account joins the same one. The transaction is the caller's — HTTP
 * supplies it through `TransactionInterceptor`, and `EmployeeHirePort` promises
 * the same to recruitment — so a failure anywhere in the sequence leaves no
 * employee, no burnt counter value, and no orphan placement.
 *
 * That property is what makes BR-ORG-002 enforceable at all: "position and
 * branch are mandatory create inputs" is only true if the row cannot exist
 * without them, and a two-step create with a follow-up assignment would make an
 * unplaced employee an ordinary intermediate state instead of an anomaly.
 */
@Injectable()
export class HireUseCase {
  constructor(
    @Inject(EMPLOYEE_REPOSITORY) private readonly employees: EmployeeRepositoryPort,
    @Inject(CONTRACT_REPOSITORY) private readonly contracts: ContractRepositoryPort,
    @Inject(STATUS_HISTORY_REPOSITORY) private readonly history: StatusHistoryRepositoryPort,
    @Inject(EMPLOYEE_NUMBER_COUNTER) private readonly counter: EmployeeNumberCounterPort,
    @Inject(ORG_PLACEMENT_PORT) private readonly placement: OrgPlacementPort,
    @Inject(ACCOUNT_LIFECYCLE_PORT) private readonly accounts: AccountLifecyclePort,
    private readonly keys: TenantKeyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: EmployeeCreateInput): Promise<Result<EmployeeRow>> {
    const inScope = await requireCompanyInScope(input.companyId);
    if (!inScope.ok) return inScope;

    // BR-EMP-007's CHECK, stated here as well as in the DTO because
    // `EmployeeHirePort` has callers — import rows, recruitment conversion —
    // that never pass through a DTO. A DB CHECK violation would surface as
    // `SYS_INTERNAL` where §8 asks for a field entry.
    if (input.employmentType === 'pkwt' && !input.contractEndDate) {
      return fail(required('contractEndDate'));
    }

    const duplicateCheck = await this.checkIdentifiers(input);
    if (duplicateCheck) return fail(duplicateCheck);

    // Sequential awaits throughout — one transaction is one `pg` socket
    // (coding-standards-nestjs §4).
    const employeeNumber = input.employeeNumber ?? (await this.counter.next(input.companyId));

    try {
      const employee = await this.employees.create(input, employeeNumber);

      await this.contracts.create({
        employeeId: employee.id,
        kind: input.employmentType,
        startDate: input.joinDate,
        endDate: input.contractEndDate ?? null,
        fileId: input.contractFileId ?? null,
        note: null,
      });

      // `applied_at` is stamped: a hire takes effect the moment it is recorded,
      // so the effectuate job must never pick this row up and re-apply it.
      await this.history.insert({
        employeeId: employee.id,
        status: 'active',
        source: 'hire',
        effectiveDate: input.joinDate,
        appliedAt: this.clock.now(),
      });

      const placed = await this.placement.assignOnHire(
        employee.id,
        input.positionId,
        input.branchId,
        input.joinDate,
      );
      // The `ORG_` code travels out unchanged (§5): organization owns the rule
      // that was violated, so it owns the code the client branches on.
      if (!placed.ok) return placed;

      if (input.createAccount) {
        const account = await this.accounts.createUserForEmployee(
          employee.id,
          input.createAccount.email,
        );
        if (!account.ok) return account;
        await this.employees.linkUser(employee.id, account.value.userId);
        return ok({ ...employee, userId: account.value.userId });
      }

      return ok(employee);
    } catch (error) {
      const mapped = mapConstraintViolation(error);
      if (mapped) return fail(mapped);
      throw error;
    }
  }

  /**
   * BR-EMP-001 on the blind index, never on ciphertext. Pre-checked so §7's
   * `VAL_DUPLICATE` can name the field; the partial unique index stays the real
   * guard for two hires racing on the same NIK, and `mapConstraintViolation`
   * turns that race into the same answer.
   */
  private async checkIdentifiers(input: EmployeeCreateInput) {
    const indexKey = await this.keys.indexKey();

    if (await this.employees.findLiveByNikBidx(blindIndex(indexKey, input.nik))) {
      return duplicate('nik');
    }
    if (input.npwp && (await this.employees.findLiveByNpwpBidx(blindIndex(indexKey, input.npwp)))) {
      return duplicate('npwp');
    }
    return null;
  }
}
