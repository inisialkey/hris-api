import { Injectable } from '@nestjs/common';

import type { Result } from '../../../shared/result';
import type { OrgPlacementPort } from '../domain/organization.ports';
import { MoveUseCase } from './move.use-case';

/**
 * `OrgPlacementPort` — the write surface employee.md and recruitment reach
 * through, and the reason BR-ORG-002 can say placement is mandatory from day one:
 * both calls run **inside the caller's transaction**, so an employee row and its
 * hire assignment commit together or not at all.
 *
 * A thin facade over `MoveUseCase` on purpose. The rules a hire has to satisfy
 * are the rules a move has to satisfy, minus the two that cannot apply on the
 * first day, and having a second implementation of them is how the two paths
 * would drift.
 */
@Injectable()
export class OrgPlacementService implements OrgPlacementPort {
  constructor(private readonly moves: MoveUseCase) {}

  assignOnHire(
    employeeId: string,
    positionId: string,
    branchId: string,
    effectiveFrom: string,
  ): Promise<Result<void>> {
    return this.moves.assignOnHire(employeeId, positionId, branchId, effectiveFrom);
  }

  closeOnExit(employeeId: string, effectiveDate: string): Promise<Result<void>> {
    return this.moves.closeOnExit(employeeId, effectiveDate);
  }
}
