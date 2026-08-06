import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import {
  AUDIT_PORT,
  AUDIT_REPOSITORY,
  type AuditLogFilter,
  type AuditLogRow,
  type AuditPort,
  type AuditRepositoryPort,
  type KeysetCursor,
} from '../domain/audit.ports';

/**
 * UC-AUD-004 — the read surface, and BR-AUD-007's recursive case: reading the
 * audit log is itself a registered sensitive read (`audit.log.queried`, §4.3),
 * so nobody inspects this table without leaving a row saying they did.
 *
 * **The read runs before the audit insert**, and that ordering is deliberate
 * twice over. A query must not return its own audit row — self-inclusion would
 * make the first page of an unfiltered feed a hall of mirrors. And fail-closed
 * still holds, because the promise UC-AUD-003 makes is that the insert precedes
 * the *response*: both statements share the request's transaction, so a failed
 * insert rolls the read back with it.
 */
@Injectable()
export class AuditQueryUseCase {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort,
    // The port, not the class: this module is `AuditPort`'s first consumer as
    // well as its implementer, and depending on the concrete service here would
    // be the one import that makes the facade rule a matter of etiquette.
    @Inject(AUDIT_PORT) private readonly audit: AuditPort,
  ) {}

  async list(
    filter: AuditLogFilter,
    page: { limit: number; after?: KeysetCursor },
  ): Promise<Result<{ rows: AuditLogRow[]; hasMore: boolean }>> {
    // §8's cross-field rule. It sits here rather than on the DTO because a
    // pair check is not a shape check, and an inverted range must be refused
    // before it becomes a query that correctly returns nothing.
    if (filter.from && filter.to && filter.from >= filter.to) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'to',
            code: fieldCodes.dateRangeInvalid,
            messageKey: `errors.${fieldCodes.dateRangeInvalid}`,
            params: { from: filter.from.toISOString(), to: filter.to.toISOString() },
          },
        ]),
      );
    }

    const found = await this.repository.list(filter, page);

    // Filters, never results — §4.3's parenthesis is a rule: recording what came
    // back would copy the very rows an access log exists to protect into a
    // second, unmasked place.
    await this.audit.sensitiveRead('audit.log.queried', 'audit_log', undefined, {
      filters: serializeFilter(filter),
      limit: page.limit,
    });

    return ok(found);
  }

  async detail(id: string): Promise<Result<AuditLogRow>> {
    const row = await this.repository.findById(id);
    // A row outside the tenant is invisible to RLS, so this is a miss and never
    // a 403 — the same answer either way (error-catalog §2 existence hiding).
    if (!row) return fail(sharedErrors.notFound());

    await this.audit.sensitiveRead('audit.log.queried', 'audit_log', id, { filters: { id } });

    return ok(row);
  }
}

/** `metadata` is jsonb; a `Date` in it would serialize inconsistently across drivers. */
function serializeFilter(filter: AuditLogFilter): Record<string, unknown> {
  return {
    ...filter,
    from: filter.from?.toISOString(),
    to: filter.to?.toISOString(),
  };
}
