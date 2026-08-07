import { Injectable } from '@nestjs/common';

import type { Result } from '../../../shared/result';
import { type EmployeeHirePort } from '../domain/employee.ports';
import type { EmployeeCreateInput } from '../domain/employee.types';
import { HireUseCase } from './hire.use-case';

/**
 * `EmployeeHirePort` (§13). Deliberately a projection and nothing else — its
 * whole reason for existing is that recruitment's conversion runs **the same**
 * UC-EMP-001, in recruitment's transaction, rather than a second hire path with
 * its own idea of what a hire is.
 *
 * The projection is `Result<{ employeeId }>` rather than the row: a caller
 * outside this module has no business receiving the ADR-0016 set in plaintext
 * just because it created the person carrying it.
 */
@Injectable()
export class EmployeeHireService implements EmployeeHirePort {
  constructor(private readonly hireUseCase: HireUseCase) {}

  async hire(input: EmployeeCreateInput): Promise<Result<{ employeeId: string }>> {
    const result = await this.hireUseCase.execute(input);
    return result.ok ? { ok: true, value: { employeeId: result.value.id } } : result;
  }
}
