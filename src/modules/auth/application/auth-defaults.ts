/**
 * The `auth.*` platform defaults (settings.md registry values), as constants
 * until the settings module lands and makes them tenant-tunable. Each name
 * carries its settings key so the swap is a mechanical find.
 *
 * Reset/invite token TTLs are platform-fixed — no settings keys, ever
 * (security-standards §2, grilled 2026-08-02).
 */
export const AUTH_DEFAULTS = {
  /** `auth.max_active_devices` */
  maxActiveDevices: 1,
  /** `auth.device_replacement_policy` */
  deviceReplacementPolicy: 'self_service' as 'self_service' | 'admin',
  /** `auth.refresh_sliding_days_mobile` */
  refreshSlidingDaysMobile: 30,
  /** `auth.refresh_absolute_days_mobile` */
  refreshAbsoluteDaysMobile: 90,
  /** `auth.refresh_sliding_days_web` */
  refreshSlidingDaysWeb: 7,
  /** `auth.refresh_absolute_days_web` */
  refreshAbsoluteDaysWeb: 30,
  /** `auth.refresh_unremembered_hours_web` */
  refreshUnrememberedHoursWeb: 12,
} as const;

/** Platform-fixed (BR-AUTH-010). */
export const RESET_TOKEN_TTL_MINUTES = 30;
export const INVITE_TOKEN_TTL_DAYS = 7;
