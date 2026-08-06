import { Module } from '@nestjs/common';

import { OutboxRepository } from '../../database/outbox.repository';
import { registerErrorStatuses } from '../../shared/error-status.registry';
import { AuthzModule } from '../authz';
import { SettingWriteUseCase } from './application/setting-write.use-case';
import { SettingsService } from './application/settings.service';
import { settingsErrorStatus } from './domain/settings.errors';
import {
  SETTINGS_CACHE,
  SETTINGS_OUTBOX,
  SETTINGS_PORT,
  SETTING_VALUE_REPOSITORY,
} from './domain/settings.ports';
import { SettingValueRepository } from './infrastructure/setting-value.repository';
import { SettingsCache } from './infrastructure/settings-cache.service';
import { SettingsController } from './presentation/settings.controller';

registerErrorStatuses(settingsErrorStatus);

/**
 * `SETTINGS_PORT` is the module's whole outward surface: every other module
 * resolves and none of them writes, which is what makes the admin editor the
 * single write path (§2 — there is no other).
 */
@Module({
  imports: [AuthzModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    SettingWriteUseCase,
    { provide: SETTINGS_PORT, useExisting: SettingsService },
    { provide: SETTING_VALUE_REPOSITORY, useClass: SettingValueRepository },
    { provide: SETTINGS_CACHE, useClass: SettingsCache },
    { provide: SETTINGS_OUTBOX, useExisting: OutboxRepository },
  ],
  exports: [SETTINGS_PORT],
})
export class SettingsModule {}
