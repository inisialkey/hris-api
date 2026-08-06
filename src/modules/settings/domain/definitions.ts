import type { SettingDefinition } from './setting.types';

/**
 * The code-owned registry (BR-SET-001), mirroring settings.md §4.2.
 *
 * **Fourteen §4.2 rows are deliberately absent, and one rule cuts them out:** a
 * row whose default carries `⚠️ VERIFY` states a regulation-dependent number,
 * and `ai-development-guide.md` §5 is absolute — *an assistant never types a
 * regulatory number, not in code, not in a migration, not in a comment*. A seed
 * is worse than a fixture for this, because a fixture asserts and a seed
 * **runs**: a tenant would be configured against a number nobody signed. Those
 * keys are registered by the session that builds their module, when a human has
 * verified the figure. The absentees are the four `overtime.*` hour limits, the
 * four `payroll.*` proration and overtime-basis keys, `bpjs.wage_floor`,
 * `tax`-adjacent none, `leave.carry_over_expiry_months`,
 * `attendance.selfie_retention_months`, `holiday.cuti_bersama_deducts_leave`,
 * `recruitment.candidate_retention_days`, and
 * `announcement.acknowledgment_retention_days`.
 *
 * Every other §4.2 row is here, including keys whose module has not been built.
 * That is not speculation but the point of the registry: definitions are seeded
 * at release and consumers arrive later, which is what lets a module ship
 * reading a key an admin has already been able to set.
 *
 * `validation.direction` is carried for the editor (§6 renders "minimum 10 —
 * platform floor"); the *enforcement* is the neighbouring bound, because every
 * direction-constrained key here states its constraint as a floor or a ceiling.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  // ── sync (offline-sync §3, §7) ────────────────────────────────────────────
  def('sync.retry_base_seconds', 'sync', 'integer', 10, {
    clientVisible: true,
    validation: { min: 1, max: 300 },
    description: 'Base delay before the first offline-queue retry',
  }),
  def('sync.retry_cap_minutes', 'sync', 'integer', 30, {
    clientVisible: true,
    validation: { min: 1, max: 1440 },
    description: 'Ceiling on the exponential retry backoff',
  }),
  def('sync.banner_after_failures', 'sync', 'integer', 3, {
    clientVisible: true,
    validation: { min: 1, max: 20 },
    description: 'Consecutive sync failures before the client shows a banner',
  }),

  // ── auth (ADR-0004, security-standards §2) ────────────────────────────────
  def('auth.max_active_devices', 'auth', 'integer', 1, {
    validation: { min: 1, max: 10 },
    description: 'Active mobile installs one user may hold at once (BR-AUTH-007)',
  }),
  def('auth.device_replacement_policy', 'auth', 'enum', 'self_service', {
    validation: { enum: ['self_service', 'admin'] },
    description: 'Whether a user may replace their own device or must ask an admin',
  }),
  def('auth.password_min_length', 'auth', 'integer', 10, {
    // tighten_only: the platform floor is the loosest a tenant may be.
    validation: { min: 10, max: 128, direction: 'tighten_only' },
    description: 'Minimum password length; a tenant may raise it, never lower it',
  }),
  def('auth.lockout_attempts', 'auth', 'integer', 5, {
    // Tightening is downward here — fewer attempts before the lock — and 3 is
    // the floor below which the account is unusable rather than protected.
    validation: { min: 3, max: 5, direction: 'tighten_only' },
    description: 'Failed logins before the account locks',
  }),
  def('auth.lockout_minutes', 'auth', 'integer', 15, {
    validation: { min: 1, max: 1440 },
    description: 'How long an automatic lockout lasts',
  }),
  def('auth.refresh_sliding_days_mobile', 'auth', 'integer', 30, {
    validation: { min: 1, max: 365 },
    description: 'Mobile idle window before a refresh token stops being accepted',
  }),
  def('auth.refresh_absolute_days_mobile', 'auth', 'integer', 90, {
    validation: { min: 1, max: 365 },
    description: 'Mobile session lifetime regardless of activity',
  }),
  def('auth.refresh_sliding_days_web', 'auth', 'integer', 7, {
    validation: { min: 1, max: 365 },
    description: 'Web idle window before a refresh token stops being accepted',
  }),
  def('auth.refresh_absolute_days_web', 'auth', 'integer', 30, {
    validation: { min: 1, max: 365 },
    description: 'Web session lifetime for a remembered device',
  }),
  def('auth.refresh_unremembered_hours_web', 'auth', 'integer', 12, {
    validation: { min: 1, max: 168 },
    description: 'Web session lifetime when the device was not remembered',
  }),

  // ── approval (approval-engine §4, BR-APRV-006) ────────────────────────────
  def('approval.max_chain_depth', 'approval', 'integer', 5, {
    validation: { min: 1, max: 10 },
    description: 'Maximum number of steps an approval chain may declare',
  }),
  def('approval.fallback_role', 'approval', 'string', 'hr_admin', {
    allowedLevels: ['tenant', 'company'],
    description: 'Role that receives a step whose resolved assignee does not exist',
  }),

  // ── notification / inbox ──────────────────────────────────────────────────
  def('notification.retention_days', 'notification', 'integer', 90, {
    validation: { min: 1, max: 3650 },
    description: 'How long delivered notifications are kept',
  }),
  def('inbox.retention_days', 'inbox', 'integer', 180, {
    validation: { min: 1, max: 3650 },
    description: 'How long non-open inbox items are kept',
  }),

  // ── document storage ──────────────────────────────────────────────────────
  def('document.expiry_reminder_days', 'document', 'integer', 30, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 365 },
    description: 'How far ahead an expiring document is flagged',
  }),
  def('document.employee_document_max_size_mb', 'document', 'integer', 10, {
    clientVisible: true,
    // Tightening is downward: the platform ceiling is the loosest allowed.
    validation: { min: 1, max: 10, direction: 'tighten_only' },
    description: 'Upload ceiling for an employee document',
  }),
  def('document.receipt_max_size_mb', 'document', 'integer', 10, {
    clientVisible: true,
    validation: { min: 1, max: 10, direction: 'tighten_only' },
    description: 'Upload ceiling for an expense receipt',
  }),

  // ── audit (BR-AUD-010) ────────────────────────────────────────────────────
  def('audit.hot_retention_months', 'audit', 'integer', 24, {
    validation: { min: 12, max: 120, direction: 'tighten_only' },
    description: 'How long audit rows stay hot before the archive job moves them',
  }),

  // ── import / export ───────────────────────────────────────────────────────
  def('import-export.max_rows', 'import-export', 'integer', 10000, {
    validation: { min: 1, max: 10000, direction: 'tighten_only' },
    description: 'Row ceiling on a single import or export',
  }),
  def('import-export.retention_days', 'import-export', 'integer', 365, {
    validation: { min: 1, max: 3650 },
    description: 'How long import/export job rows and their artifacts are kept',
  }),

  // ── employee ──────────────────────────────────────────────────────────────
  def('employee.contract_reminder_days', 'employee', 'string', '60,30', {
    allowedLevels: ['tenant', 'company'],
    validation: { pattern: '^\\d+(,\\d+)*$' },
    description: 'Descending day offsets at which a contract expiry is announced',
  }),

  // ── attendance (the client-visible set — read before an offline punch) ─────
  def('attendance.geofence_radius_m', 'attendance', 'integer', 100, {
    allowedLevels: ['tenant', 'company', 'branch'],
    clientVisible: true,
    validation: { min: 10, max: 5000 },
    description: 'Radius around a branch within which a punch is inside the fence',
  }),
  def('attendance.geofence_policy', 'attendance', 'enum', 'flag', {
    allowedLevels: ['tenant', 'company', 'branch'],
    clientVisible: true,
    validation: { enum: ['flag', 'strict'] },
    description: 'Whether an out-of-fence punch is flagged or refused',
  }),
  def('attendance.selfie_required', 'attendance', 'boolean', true, {
    allowedLevels: ['tenant', 'company', 'branch'],
    clientVisible: true,
    description: 'Whether a punch must carry a selfie',
  }),
  def('attendance.qr_required', 'attendance', 'boolean', false, {
    allowedLevels: ['tenant', 'company', 'branch'],
    clientVisible: true,
    description: 'Whether a punch must scan the branch QR poster',
  }),
  def('attendance.qr_key_version', 'attendance', 'integer', 1, {
    allowedLevels: ['branch'],
    validation: { min: 1 },
    description: 'Bumping this invalidates every printed QR poster for the branch',
  }),

  // ── leave ─────────────────────────────────────────────────────────────────
  def('leave.annual_period_basis', 'leave', 'enum', 'calendar', {
    allowedLevels: ['company'],
    validation: { enum: ['calendar', 'anniversary'] },
    description: 'Whether annual leave periods follow the calendar or the hire date',
  }),
  def('leave.balance_expiry_notice_days', 'leave', 'integer', 30, {
    validation: { min: 1, max: 365 },
    description: 'How far ahead an expiring leave balance is announced',
  }),

  // ── overtime (policy keys only — the hour limits are statutory) ────────────
  def('overtime.compensation_mode', 'overtime', 'enum', 'pay', {
    allowedLevels: ['tenant', 'company'],
    clientVisible: true,
    validation: { enum: ['pay', 'toil', 'employee_choice'] },
    description: 'How overtime is compensated; only employee_choice lets a requester pick',
  }),
  def('overtime.max_backdate_days', 'overtime', 'integer', 7, {
    allowedLevels: ['tenant', 'company'],
    clientVisible: true,
    validation: { min: 0, max: 90 },
    description: 'How late unplanned overtime may still be filed',
  }),

  // ── payroll (policy keys only) ────────────────────────────────────────────
  def('payroll.cutoff_day', 'payroll', 'integer', 25, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 31 },
    description: 'Default cutoff the new-run wizard proposes; the run declares its own period',
  }),
  def('payroll.retro_window_months', 'payroll', 'integer', 24, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 120 },
    description: 'How far back a dirty period may still become a payslip line',
  }),

  // ── tax (the only tax key — rates and brackets are platform tables) ───────
  def('tax.method', 'tax', 'enum', 'gross', {
    allowedLevels: ['tenant', 'company'],
    effectiveDated: true,
    validation: { enum: ['gross', 'gross_up'] },
    requiredPermission: 'settings.statutory_policy.configure',
    description: 'Company withholding default; an employee tax profile overrides it',
  }),

  // ── expense ───────────────────────────────────────────────────────────────
  def('expense.max_backdate_days', 'expense', 'integer', 90, {
    allowedLevels: ['tenant', 'company'],
    clientVisible: true,
    validation: { min: 0, max: 365 },
    description: 'How old a line’s incurred date may be at submission',
  }),

  // ── performance / training / announcement ─────────────────────────────────
  def('performance.reminder_lead_days', 'performance', 'integer', 7, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 90 },
    description: 'How far ahead review-cycle deadlines start nudging',
  }),
  def('training.session_reminder_days', 'training', 'integer', 3, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 90 },
    description: 'How far ahead an enrolled seat is reminded of a session',
  }),
  def('training.certification_expiry_notice_days', 'training', 'integer', 60, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 365 },
    description: 'How far ahead a lapsing credential warns its holder and HR',
  }),
  def('announcement.retention_days', 'announcement', 'integer', 365, {
    allowedLevels: ['tenant', 'company'],
    validation: { min: 1, max: 3650 },
    description: 'How long a published post without a required acknowledgment is kept',
  }),
];

/** Lookup by key. Unknown key on a read is a programmer error (UC-SET-001). */
export const SETTING_DEFINITIONS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

type DefOptions = Partial<Omit<SettingDefinition, 'key' | 'module' | 'type' | 'defaultValue'>> & {
  description: string;
};

/** Defaults match §4.1's column defaults: tenant-only, undated, admin-only. */
function def(
  key: string,
  module: string,
  type: SettingDefinition['type'],
  defaultValue: unknown,
  options: DefOptions,
): SettingDefinition {
  return {
    key,
    module,
    type,
    defaultValue,
    allowedLevels: options.allowedLevels ?? ['tenant'],
    effectiveDated: options.effectiveDated ?? false,
    clientVisible: options.clientVisible ?? false,
    ...(options.validation ? { validation: options.validation } : {}),
    ...(options.requiredPermission ? { requiredPermission: options.requiredPermission } : {}),
    description: options.description,
  };
}
