import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { OffsetMeta } from '../../../shared/envelope';
import { requireRequestContext, requireTenantContext } from '../../../shared/context';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { AppErrorException, unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, RequirePermission } from '../../authz';
import { SettingsService } from '../application/settings.service';
import { SettingWriteUseCase, type SettingActor } from '../application/setting-write.use-case';
import { SETTING_DEFINITIONS } from '../domain/definitions';
import {
  SETTING_VALUE_REPOSITORY,
  type ExactScope,
  type SettingValueRepositoryPort,
} from '../domain/settings.ports';
import { DefinitionQueryDto, ValueQueryDto, WriteValueDto } from './dto/settings.dto';

/**
 * §7's five endpoints. Four are the admin editor; the fifth is the client
 * bootstrap and is the only one without a permission key — every authenticated
 * caller needs the tunables that shape their own app (UC-SET-005), and BR-SET-007
 * is what makes that safe by keeping everything else off the map.
 *
 * `POST` carries `settings.setting.configure`. A definition-level override is
 * checked in the use case rather than here, because which key it is depends on
 * the body — a decorator cannot see that.
 */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly writes: SettingWriteUseCase,
    @Inject(SETTING_VALUE_REPOSITORY) private readonly repository: SettingValueRepositoryPort,
  ) {}

  @Get('definitions')
  @RequirePermission('settings.setting.read')
  @ApiOperation({ operationId: 'listSettingDefinitions', summary: 'The code-owned registry' })
  listDefinitions(@Query() query: DefinitionQueryDto) {
    const definitions = SETTING_DEFINITIONS.filter(
      (definition) => !query.module || definition.module === query.module,
    );

    // Grouped by module, because that is how the editor is laid out (§6) and
    // because the alternative is every client regrouping the same list.
    const byModule = new Map<string, typeof definitions>();
    for (const definition of definitions) {
      byModule.set(definition.module, [...(byModule.get(definition.module) ?? []), definition]);
    }

    return [...byModule.entries()].map(([module, entries]) => ({
      module,
      definitions: entries.map((definition) => ({
        key: definition.key,
        type: definition.type,
        allowedLevels: definition.allowedLevels,
        defaultValue: definition.defaultValue,
        validation: definition.validation ?? null,
        effectiveDated: definition.effectiveDated,
        clientVisible: definition.clientVisible,
        requiredPermission: definition.requiredPermission ?? null,
        description: definition.description,
        // Nothing is deprecated yet. The field ships because the editor branches
        // on it (§9) and a client that has never seen it will not start.
        deprecated: false,
      })),
    }));
  }

  @Get('values')
  @RequirePermission('settings.setting.read')
  @ApiOperation({ operationId: 'listSettingValues', summary: 'Full history for one key and scope' })
  async listValues(@Query() query: ValueQueryDto) {
    // A branch id with no company id would build a scope no real row can match
    // — every branch row carries a company (§4.1 CHECK) — and the caller would
    // get a silently empty history instead of being told what is wrong.
    if (query.branchId && !query.companyId) {
      throw new AppErrorException(
        sharedErrors.validationFailed([
          {
            field: 'companyId',
            code: fieldCodes.required,
            messageKey: `errors.${fieldCodes.required}`,
          },
        ]),
      );
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const scope: ExactScope = {
      level: query.branchId ? 'branch' : query.companyId ? 'company' : 'tenant',
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    };

    const found = await this.repository.listHistory(query.key, scope, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    return {
      data: found.rows.map((row) => ({
        id: row.id,
        key: row.key,
        level: row.level,
        companyId: row.companyId,
        branchId: row.branchId,
        value: row.value,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })),
      meta: offsetMeta(page, pageSize, found.total),
    };
  }

  @Post('values')
  @RequirePermission('settings.setting.configure')
  @ApiOperation({ operationId: 'writeSettingValue', summary: 'Set or schedule a value' })
  async writeValue(@Body() dto: WriteValueDto) {
    return unwrap(
      await this.writes.write(
        this.actor(),
        {
          key: dto.key,
          level: dto.level,
          companyId: dto.companyId,
          branchId: dto.branchId,
          value: dto.value,
          effectiveFrom: dto.effectiveFrom,
        },
        this.settings.today(),
      ),
    );
  }

  @Delete('values/:id')
  @RequirePermission('settings.setting.configure')
  @HttpCode(200)
  @ApiOperation({ operationId: 'cancelSettingValue', summary: 'Cancel a scheduled change' })
  async cancelValue(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.writes.cancel(id, this.settings.today()));
  }

  @Get('effective')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'effectiveSettings', summary: 'Client-visible map for the caller' })
  async effective() {
    // UC-SET-005: the caller's employee placement supplies company and branch.
    // Nothing supplies it yet — the employee module owns that read — so every
    // caller resolves at tenant scope, which is the answer the use case already
    // specifies for a caller without a placement.
    const values = await this.settings.resolveClientVisible({});
    return { values, resolvedAt: this.settings.now() };
  }

  private actor(): SettingActor {
    const request = requireRequestContext();
    requireTenantContext();
    return {
      // Lazy on purpose (ADR-0005): a key with no definition-level override
      // never resolves, because the guard already checked the one that matters.
      has: async (permission: string) => {
        const authorization = await request.authorization?.resolve();
        return authorization?.permissions.has(permission) ?? false;
      },
      companyScope: async () => {
        const authorization = await request.authorization?.resolve();
        return authorization?.companyScope ?? [];
      },
    };
  }
}

function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
