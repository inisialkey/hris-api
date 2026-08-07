import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { approvalErrors } from '../domain/approval.errors';
import {
  APPROVAL_DIRECTORY,
  DELEGATION_REPOSITORY,
  type ApprovalDirectoryPort,
  type DelegationRepositoryPort,
  type Page,
  type Paged,
} from '../domain/approval.ports';
import type { DelegationRow } from '../domain/approval.types';
import { isRegisteredRequestType } from '../domain/request-types';
import { overlapping } from '../domain/resolution';

export interface DelegationInput {
  delegatorUserId: string;
  delegateUserId: string;
  requestTypes?: string[] | null;
  startDate: string;
  endDate: string;
}

/** UC-APRV-006. */
@Injectable()
export class DelegationService {
  constructor(
    @Inject(DELEGATION_REPOSITORY) private readonly delegations: DelegationRepositoryPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(filter: { delegatorUserId?: string }, page: Page): Promise<Paged<DelegationRow>> {
    return this.delegations.list(filter, page);
  }

  async create(input: DelegationInput): Promise<Result<DelegationRow>> {
    if (input.delegatorUserId === input.delegateUserId) {
      return fail(approvalErrors.selfDelegation());
    }
    if (input.startDate > input.endDate) {
      return fail(entryError('endDate', fieldCodes.dateRangeInvalid));
    }
    for (const requestType of input.requestTypes ?? []) {
      if (!isRegisteredRequestType(requestType)) {
        return fail(entryError('requestTypes', fieldCodes.invalidEnum, { requestType }));
      }
    }

    // §7: "unknown users → 404". Both are checked, and through the directory for
    // `ChainService.refExists`' reason — a delegate has to be someone who could
    // have held the seat in the first place.
    const known = await this.directory.byUserIds([input.delegatorUserId, input.delegateUserId]);
    if (known.size < 2) return fail(sharedErrors.notFound());

    // The overlap rule reads rows that do not exist yet, so the lock comes first
    // (`lockDelegator`) — otherwise two admins filling in the same absence at the
    // same moment both see no conflict and both write one.
    await this.delegations.lockDelegator(input.delegatorUserId);
    const existing = await this.delegations.listForDelegator(input.delegatorUserId);
    const conflict = overlapping(existing, {
      startDate: input.startDate,
      endDate: input.endDate,
      requestTypes: input.requestTypes ?? null,
    });
    if (conflict) {
      return fail(approvalErrors.delegationOverlap({ conflictingDelegationId: conflict.id }));
    }

    return ok(
      await this.delegations.create({
        delegatorUserId: input.delegatorUserId,
        delegateUserId: input.delegateUserId,
        requestTypes: input.requestTypes ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
    );
  }

  /**
   * Revoking affects **future activations only** (UC-APRV-006). Items already
   * assigned stay with the delegate, because they were validly assigned and
   * retro-redirecting would rewrite a live inbox — the same reasoning §9 gives
   * for a delegation created after activation being inert.
   */
  async revoke(
    id: string,
    actorUserId: string,
    canManageOthers: boolean,
  ): Promise<Result<{ id: string }>> {
    const existing = await this.delegations.findById(id);
    if (!existing) return fail(sharedErrors.notFound());
    if (!canManageOthers && existing.delegatorUserId !== actorUserId) {
      // 404 rather than 403: somebody else's delegation is not a row this caller
      // may know exists (api-standards §11, existence hiding).
      return fail(sharedErrors.notFound());
    }
    if (existing.revokedAt !== null) return ok({ id });

    const revoked = await this.delegations.revoke(id, this.clock.now());
    return revoked ? ok({ id }) : fail(sharedErrors.notFound());
  }
}

function entryError(field: string, code: string, params?: Record<string, unknown>) {
  return sharedErrors.validationFailed([
    { field, code, messageKey: `errors.${code}`, params: { field, ...params } },
  ]);
}
