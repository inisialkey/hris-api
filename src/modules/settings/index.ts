// The settings facade — the only import path other modules may use (ADR-0001 §1).
//
// One port, and it only reads. Writing a value is the admin editor's job (§2),
// so a module that wanted to set one would be inventing tenant policy on the
// tenant's behalf.

export { SettingsModule } from './settings.module';
export { SETTINGS_PORT, type SettingsPort } from './domain/settings.ports';
export type { SettingScope } from './domain/setting.types';
