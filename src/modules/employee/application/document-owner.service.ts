import { Inject, Injectable } from '@nestjs/common';

import { requireCompanyInScope } from '../../../shared/data-scope';
import { requireRequestContext } from '../../../shared/context';
import type { EntityRef, FileOwner } from '../../document';
import { DIRECTORY_READER, type DirectoryReaderPort } from '../domain/employee.ports';

/**
 * document-storage §4.2's open duty for `employee_document`, discharged here —
 * employee.md §2: *"Document-storage binds `employee_document` category
 * permissions to the three `employee.document.*` keys with this module's
 * ownership resolver (self = subject employee's own committed files)"*.
 *
 * The resolver answers both halves of §2's gate in one predicate, which is what
 * `FileOwner` asks for and what §2's own wording requires: the read gate is
 * *"`employee.document.read` (self: own docs without key)"*, and a static
 * permission key cannot express "or self".
 *
 * Every miss is `false`, which document-storage turns into 404 — *"Out-of-scope
 * employees are 404 (existence hiding)"*, employee.md §2's last line.
 */
@Injectable()
export class EmployeeDocumentOwner implements FileOwner {
  readonly module = 'employee';
  /** UC-EMP-010 attaches to the employee; `employee_documents` binds the row. */
  readonly entityTypes = ['employee'] as const;

  constructor(@Inject(DIRECTORY_READER) private readonly directory: DirectoryReaderPort) {}

  canWrite(ref: EntityRef): Promise<boolean> {
    return this.permitted(ref, 'employee.document.create', false);
  }

  /** Self needs no key; anyone else needs the key **and** the company scope. */
  canRead(ref: EntityRef): Promise<boolean> {
    return this.permitted(ref, 'employee.document.read', true);
  }

  canDelete(ref: EntityRef): Promise<boolean> {
    return this.permitted(ref, 'employee.document.delete', false);
  }

  private async permitted(ref: EntityRef, key: string, allowSelf: boolean): Promise<boolean> {
    const [employee] = await this.directory.byEmployeeIds([ref.entityId]);
    if (!employee) return false;

    const request = requireRequestContext();
    if (allowSelf && employee.userId !== null && employee.userId === request.userId) return true;

    const authorization = await request.authorization?.resolve();
    if (!authorization?.permissions.has(key)) return false;
    return (await requireCompanyInScope(employee.companyId)).ok;
  }
}
