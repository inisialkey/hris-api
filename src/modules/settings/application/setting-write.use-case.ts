import { Inject, Injectable } from '@nestjs/common';

import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { requireTenantContext } from '../../../shared/context';
import { authzErrors } from '../../authz';
import { planCancel, planWrite } from '../domain/plan-write';
import type { SettingLevel, SettingValueRow } from '../domain/setting.types';
import {
  SETTINGS_CACHE,
  SETTINGS_OUTBOX,
  SETTING_VALUE_REPOSITORY,
  type ExactScope,
  type SettingValueRepositoryPort,
  type SettingsCachePort,
  type SettingsOutboxPort,
} from '../domain/settings.ports';
import { validateValue } from '../domain/validate-value';
import { SETTING_DEFINITIONS_BY_KEY } from '../domain/definitions';

export interface SettingWriteCommand {
  key: string;
  level: SettingLevel;
  companyId?: string;
  branchId?: string;
  value: unknown;
  effectiveFrom?: string;
}

/**
 * The caller's own authority, resolved lazily. `has` is a thunk for ADR-0005's
 * reason and `companyScope` decides which companies exist as far as this caller
 * is concerned — a write outside it is a 404, not a 403 (§7).
 */
export interface SettingActor {
  has(permission: string): Promise<boolean>;
  companyScope(): Promise<'all' | readonly string[]>;
}

/** UC-SET-002, UC-SET-003 and UC-SET-004 — one write path, three shapes. */
@Injectable()
export class SettingWriteUseCase {
  constructor(
    @Inject(SETTING_VALUE_REPOSITORY) private readonly repository: SettingValueRepositoryPort,
    @Inject(SETTINGS_CACHE) private readonly cache: SettingsCachePort,
    @Inject(SETTINGS_OUTBOX) private readonly outbox: SettingsOutboxPort,
  ) {}

  async write(
    actor: SettingActor,
    command: SettingWriteCommand,
    today: string,
  ): Promise<Result<SettingValueRow>> {
    // BR-SET-001: tenants set values, never keys. An unknown key is a field
    // error rather than a 404 — the client sent a bad `key`, and §8 says so.
    const definition = SETTING_DEFINITIONS_BY_KEY.get(command.key);
    if (!definition) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'key',
            code: fieldCodes.invalidEnum,
            messageKey: `errors.${fieldCodes.invalidEnum}`,
          },
        ]),
      );
    }

    // §2's definition-level override. The route already demanded
    // `settings.setting.configure`, so this is the extra key a high-stakes value
    // costs — which is exactly what the matrix says: an HR Admin configures
    // settings and does not configure `tax.method`.
    if (definition.requiredPermission && !(await actor.has(definition.requiredPermission))) {
      return fail(authzErrors.permissionDenied({ permission: definition.requiredPermission }));
    }

    const scope = await this.checkScope(actor, command);
    if (!scope.ok) return scope;

    const valueErrors = validateValue(definition, command.value);
    if (valueErrors.length > 0) return fail(sharedErrors.validationFailed(valueErrors));

    const rows = await this.repository.listForKeyAtScope(command.key, scope.value);
    const plan = planWrite(
      definition,
      rows,
      { level: command.level, value: command.value, effectiveFrom: command.effectiveFrom ?? today },
      today,
    );
    if (!plan.ok) return plan;

    const written = await this.repository.applyWrite(command.key, scope.value, plan.value);
    await this.afterCommit({
      action: plan.value.action,
      key: command.key,
      level: command.level,
      companyId: command.companyId,
      branchId: command.branchId,
      effectiveFrom: plan.value.insert.effectiveFrom,
      value: command.value,
    });
    return ok(written);
  }

  async cancel(id: string, today: string): Promise<Result<{ id: string }>> {
    const target = await this.repository.findById(id);
    // RLS already hid another tenant's row, so a miss and a denial are the same
    // answer (error-catalog §2).
    if (!target) return fail(sharedErrors.notFound());

    const scope: ExactScope = {
      level: target.level,
      ...(target.companyId ? { companyId: target.companyId } : {}),
      ...(target.branchId ? { branchId: target.branchId } : {}),
    };
    const rows = await this.repository.listForKeyAtScope(target.key, scope);

    const plan = planCancel(rows, target, today);
    if (!plan.ok) return plan;

    await this.repository.applyCancel(plan.value);
    // The row is gone, so the event is the only surviving record of what was
    // cancelled — which is why §12 has `cancelled` carry the dead value.
    await this.afterCommit({
      action: 'cancelled',
      key: target.key,
      level: target.level,
      companyId: target.companyId ?? undefined,
      branchId: target.branchId ?? undefined,
      effectiveFrom: target.effectiveFrom,
      value: target.value,
    });
    return ok({ id });
  }

  /**
   * §7: a company or branch outside the caller's data scope is a **404**, not a
   * 403 — the caller must not learn that the company exists (error-catalog §2).
   */
  private async checkScope(
    actor: SettingActor,
    command: SettingWriteCommand,
  ): Promise<Result<ExactScope>> {
    if (command.level === 'tenant') return ok({ level: 'tenant' });

    if (!command.companyId) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'companyId',
            code: fieldCodes.required,
            messageKey: `errors.${fieldCodes.required}`,
          },
        ]),
      );
    }
    if (command.level === 'branch' && !command.branchId) {
      return fail(
        sharedErrors.validationFailed([
          {
            field: 'branchId',
            code: fieldCodes.required,
            messageKey: `errors.${fieldCodes.required}`,
          },
        ]),
      );
    }

    const companies = await actor.companyScope();
    if (companies !== 'all' && !companies.includes(command.companyId)) {
      return fail(sharedErrors.notFound());
    }

    return ok({
      level: command.level,
      companyId: command.companyId,
      ...(command.branchId ? { branchId: command.branchId } : {}),
    });
  }

  /**
   * BR-SET-009's bust and §12's event, in that order and both after the write.
   *
   * The bust is post-commit in the sense that matters: it runs after the rows
   * have moved, so nothing can repopulate the cache from the old state. The
   * event rides the same transaction as the change (ADR-0010) — a settings
   * change that committed and produced no fact is what the outbox exists to
   * prevent.
   */
  private async afterCommit(payload: Record<string, unknown>): Promise<void> {
    const tenant = requireTenantContext();
    await this.outbox.emit({
      name: 'settings.value.changed',
      tenantId: tenant.tenantId,
      // The aggregate is the tenant's configuration: `aggregate_id` is a uuid
      // column and a setting key is not one, so the key, level and scope travel
      // in the payload where a consumer can branch on them.
      aggregateId: tenant.tenantId,
      payload,
    });
    await this.cache.bust(tenant.tenantId);
  }
}
