import { AppError } from '../../../shared/app-error';

/** The `SET_` block of error-catalog §11 — the module's four codes, spelled once. */
export const settingsErrors = {
  levelNotAllowed: (params: { allowedLevels: string[] }) =>
    new AppError('SET_LEVEL_NOT_ALLOWED', params),
  notEffectiveDated: () => new AppError('SET_NOT_EFFECTIVE_DATED'),
  historyImmutable: () => new AppError('SET_HISTORY_IMMUTABLE'),
  scheduleOverlap: (params: { existingValueId: string }) =>
    new AppError('SET_SCHEDULE_OVERLAP', params),
} as const;

export const settingsErrorStatus = {
  SET_LEVEL_NOT_ALLOWED: 422,
  SET_NOT_EFFECTIVE_DATED: 422,
  SET_HISTORY_IMMUTABLE: 409,
  SET_SCHEDULE_OVERLAP: 409,
} as const;
