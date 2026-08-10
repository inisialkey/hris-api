import { Injectable } from '@nestjs/common';

import { requireRequestContext } from '../../../shared/context';
import type { ErrorDetailEntry } from '../../../shared/envelope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import {
  findExportDefinition,
  findImportDefinition,
  type ExportDefinition,
  type ImportDefinition,
} from '../domain/definitions';

/**
 * §2's per-definition gate, in one place because six of the ten endpoints run it.
 *
 * The routes carrying it are `@AuthenticatedOnly()` — the same **documented
 * deviation** document-storage §2 makes and for the same structural reason: the
 * key is a property of the `type` in the request, so there is no static
 * `@RequirePermission` a controller could declare. `POST /imports` needs
 * `employee.master.import` for one body and `holiday.calendar.import` for the
 * next. The route lint accepts the explicit marker; the check runs here.
 *
 * **An unrunnable definition is indistinguishable from an unknown one.** §7 says
 * `GET /definitions` filters *"to the caller's permissions (existence hiding
 * applies to definitions the caller can't run)"*, and a `POST` that answered 403
 * would hand back the fact the list was built to withhold. So both are
 * `VAL_INVALID_ENUM` on `type`, which is also exactly what §7's own error line
 * says an unknown type is.
 */
@Injectable()
export class DefinitionAccessService {
  async heldPermissions(): Promise<ReadonlySet<string>> {
    // ADR-0005's lazy resolution: an `@AuthenticatedOnly()` route resolves
    // nothing until something asks, and this is the ask.
    const authorization = await requireRequestContext().authorization?.resolve();
    return authorization?.permissions ?? new Set<string>();
  }

  async importFor(type: string): Promise<Result<ImportDefinition>> {
    const definition = findImportDefinition(type);
    if (!definition) return fail(unknownType(type));
    const held = await this.heldPermissions();
    return held.has(definition.requiredPermission) ? ok(definition) : fail(unknownType(type));
  }

  async exportFor(type: string): Promise<Result<ExportDefinition>> {
    const definition = findExportDefinition(type);
    if (!definition) return fail(unknownType(type));
    const held = await this.heldPermissions();
    return held.has(definition.requiredPermission) ? ok(definition) : fail(unknownType(type));
  }

  /**
   * The gate a job re-runs on a definition it already holds — used by the
   * `import_file` owner, which answers *"may this caller read this job's files"*
   * long after the request that created it.
   */
  async holdsImportPermission(type: string): Promise<boolean> {
    const definition = findImportDefinition(type);
    if (!definition) return false;
    return (await this.heldPermissions()).has(definition.requiredPermission);
  }
}

function unknownType(type: string) {
  const entry: ErrorDetailEntry = {
    field: 'type',
    code: fieldCodes.invalidEnum,
    messageKey: `errors.${fieldCodes.invalidEnum}`,
    // No `allowed` list. Enumerating every registered definition would undo the
    // existence hiding this refusal exists for; the caller's own
    // `GET /definitions` is the list they are entitled to.
    params: { value: type },
  };
  return sharedErrors.validationFailed([entry]);
}
