import { Inject, Injectable } from '@nestjs/common';

import { companyScope, requireCompanyInScope, requireTenantWide } from '../../../shared/data-scope';
import type { ErrorDetailEntry } from '../../../shared/envelope';
import { fail, ok, type Result } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { ROLE_HOLDER_PORT, type RoleHolderPort } from '../../authz';
import { ORG_QUERY_PORT, type OrgQueryPort } from '../../organization';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import {
  APPROVAL_DIRECTORY,
  CHAIN_REPOSITORY,
  type ApprovalDirectoryPort,
  type ChainRepositoryPort,
  type ChainWrite,
  type Page,
  type Paged,
} from '../domain/approval.ports';
import type { ChainRow, Resolver } from '../domain/approval.types';
import { isRegisteredRequestType } from '../domain/request-types';
import {
  normaliseConditions,
  normaliseSteps,
  refField,
  resolverRefs,
  validateConditions,
  validateSteps,
} from '../domain/step-config';

const MAX_DEPTH_KEY = 'approval.max_chain_depth';

export interface ChainInput {
  requestType?: string;
  companyId?: string | null;
  name?: string;
  priority?: number;
  conditions?: unknown;
  steps?: unknown;
  isActive?: boolean;
}

/**
 * UC-APRV-008. The editor's CRUD, and the three rules that make a chain set
 * usable rather than merely well-formed:
 *
 * - **A request type keeps a catch-all.** Deactivating or deleting the last
 *   empty-condition chain while conditional siblings remain is refused, because
 *   a request matching none of them would be unsubmittable.
 * - **A tenant-wide chain needs tenant-wide scope.** A company-scoped admin
 *   configures their company's chains; a chain that governs every company is not
 *   theirs to write (ADR-0005, the `requireTenantWide` rule organization set).
 * - **Resolver references are checked against live rows**, so a chain naming a
 *   deleted position fails at the write instead of stranding an instance.
 */
@Injectable()
export class ChainService {
  constructor(
    @Inject(CHAIN_REPOSITORY) private readonly chains: ChainRepositoryPort,
    @Inject(ORG_QUERY_PORT) private readonly org: OrgQueryPort,
    @Inject(ROLE_HOLDER_PORT) private readonly roles: RoleHolderPort,
    @Inject(APPROVAL_DIRECTORY) private readonly directory: ApprovalDirectoryPort,
    @Inject(SETTINGS_PORT) private readonly settings: SettingsPort,
  ) {}

  async list(
    filter: { requestType?: string; companyId?: string },
    page: Page,
  ): Promise<Result<Paged<ChainRow>>> {
    if (filter.companyId) {
      const scoped = await requireCompanyInScope(filter.companyId);
      if (!scoped.ok) return scoped;
    }
    return ok(await this.chains.list({ ...filter, companyIds: await companyScope() }, page));
  }

  async get(id: string): Promise<Result<ChainRow>> {
    const chain = await this.chains.findById(id);
    if (!chain) return fail(sharedErrors.notFound());
    const scoped = await this.scopeCheck(chain.companyId);
    return scoped.ok ? ok(chain) : scoped;
  }

  async create(input: ChainInput): Promise<Result<ChainRow>> {
    const companyId = input.companyId ?? null;
    const scoped = await this.scopeCheck(companyId);
    if (!scoped.ok) return scoped;

    if (!input.requestType || !isRegisteredRequestType(input.requestType)) {
      return fail(entryError('requestType', fieldCodes.invalidEnum));
    }

    const values = await this.validated(input, input.requestType);
    if (!values.ok) return values;

    return ok(
      await this.chains.create({
        companyId,
        requestType: input.requestType,
        name: input.name!,
        priority: input.priority ?? 100,
        conditions: values.value.conditions,
        steps: values.value.steps,
        isActive: input.isActive ?? true,
      }),
    );
  }

  async update(id: string, input: ChainInput): Promise<Result<ChainRow>> {
    const existing = await this.chains.findById(id);
    if (!existing) return fail(sharedErrors.notFound());
    const scoped = await this.scopeCheck(existing.companyId);
    if (!scoped.ok) return scoped;

    // `requestType` is not patchable: the conditions and the context fields they
    // name belong to the type, so changing it would leave a chain whose rules
    // reference fields the new type does not declare.
    const patch: Partial<ChainWrite> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (input.steps !== undefined || input.conditions !== undefined) {
      const values = await this.validated(
        {
          steps: input.steps ?? existing.steps,
          conditions: input.conditions ?? existing.conditions,
        },
        existing.requestType,
      );
      if (!values.ok) return values;
      patch.steps = values.value.steps;
      patch.conditions = values.value.conditions;
    }

    const wouldRemoveCatchAll =
      (input.isActive === false && isCatchAll(existing)) ||
      (patch.conditions !== undefined && patch.conditions !== null && isCatchAll(existing));
    if (wouldRemoveCatchAll) {
      const blocked = await this.catchAllGuard(existing);
      if (!blocked.ok) return blocked;
    }

    const updated = await this.chains.update(id, patch);
    return updated ? ok(updated) : fail(sharedErrors.notFound());
  }

  async archive(id: string): Promise<Result<{ id: string }>> {
    const existing = await this.chains.findById(id);
    if (!existing) return fail(sharedErrors.notFound());
    const scoped = await this.scopeCheck(existing.companyId);
    if (!scoped.ok) return scoped;

    if (isCatchAll(existing)) {
      const blocked = await this.catchAllGuard(existing);
      if (!blocked.ok) return blocked;
    }

    const archived = await this.chains.archive(id);
    return archived ? ok({ id }) : fail(sharedErrors.notFound());
  }

  /**
   * "A type must keep a catch-all" (UC-APRV-008). Refused only when conditional
   * siblings would be left behind: removing the last chain of a type entirely is
   * allowed, because a type with no chains at all fails loudly at submit with
   * `APRV_NO_CHAIN_CONFIGURED` rather than silently routing a request nowhere.
   */
  private async catchAllGuard(chain: ChainRow): Promise<Result<void>> {
    const siblings = await this.chains.siblings(chain.requestType, chain.companyId);
    const others = siblings.filter((row) => row.id !== chain.id && row.isActive);
    const remainingCatchAll = others.some(isCatchAll);
    if (remainingCatchAll || others.length === 0) return ok(undefined);
    return fail(entryError('isActive', fieldCodes.outOfRange, { requestType: chain.requestType }));
  }

  private async scopeCheck(companyId: string | null): Promise<Result<void>> {
    return companyId === null
      ? requireTenantWide('approval.chain.configure')
      : requireCompanyInScope(companyId);
  }

  private async validated(
    input: { steps?: unknown; conditions?: unknown },
    requestType: string,
  ): Promise<Result<{ steps: ChainWrite['steps']; conditions: ChainWrite['conditions'] }>> {
    const maxDepth = await this.settings.resolve<number>(MAX_DEPTH_KEY);
    const entries = [
      ...validateSteps(input.steps, maxDepth),
      ...validateConditions(input.conditions, requestType),
    ];
    if (entries.length > 0) return fail(sharedErrors.validationFailed(entries));

    const steps = normaliseSteps(input.steps as unknown[]);
    const refEntries = await this.checkRefs(steps);
    if (refEntries.length > 0) return fail(sharedErrors.validationFailed(refEntries));

    return ok({ steps, conditions: normaliseConditions(input.conditions) });
  }

  /**
   * §8's async row. Sequential, never `Promise.all` — this runs inside the
   * request's unit of work (coding-standards-nestjs §4) — and bounded by the
   * chain depth the tenant configured, which is a handful of references.
   */
  private async checkRefs(steps: ChainWrite['steps']): Promise<ErrorDetailEntry[]> {
    const entries: ErrorDetailEntry[] = [];
    for (const { resolver, path } of resolverRefs(steps)) {
      if (!(await this.refExists(resolver))) {
        entries.push(entry(`${path}.${refField(resolver)}`, fieldCodes.invalidEnum));
      }
    }
    return entries;
  }

  private async refExists(resolver: Resolver): Promise<boolean> {
    switch (resolver.type) {
      case 'position_holder':
        return this.org.positionExists(resolver.positionId);
      case 'role_holders':
        return this.roles.exists(resolver.roleId);
      case 'specific_user':
        // A named approver is checked against `employee_directory` rather than
        // against `users`: every other resolver in §4 answers in the user ids of
        // live employees (BR-ORG-003's holder rule filters on exactly that), and
        // a named approver who is not one of those people could not have been
        // resolved by any other rung either (A-196).
        return (await this.directory.byUserIds([resolver.userId])).size > 0;
      default:
        return true;
    }
  }
}

function isCatchAll(chain: ChainRow): boolean {
  return chain.conditions === null || chain.conditions.length === 0;
}

function entryError(
  field: string,
  code: string,
  params?: Record<string, unknown>,
): ReturnType<typeof sharedErrors.validationFailed> {
  return sharedErrors.validationFailed([entry(field, code, params)]);
}

function entry(field: string, code: string, params?: Record<string, unknown>): ErrorDetailEntry {
  return { field, code, messageKey: `errors.${code}`, params: { field, ...params } };
}
