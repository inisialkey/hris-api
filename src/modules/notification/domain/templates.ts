import type { Locale, NotificationChannel } from './notification.types';

/**
 * §4.2's registry, transcribed. **This is the whole table, not the part whose
 * modules exist** — BR-NTF-001 makes templates code-owned and §13 calls §4.2
 * *"the platform seed"*, so the copy here is complete and a module arriving
 * later calls `NotificationPort.send` with a key that is already registered
 * rather than adding one. A template nobody sends is inert: it costs a row in
 * the preference matrix and nothing else.
 *
 * Four things live on a row and each has one owner. `channels` and `mandatory`
 * are §4.2's columns and are contract. `audience` is §4.2's column verbatim as
 * prose, because **the sender resolves recipients, not the registry** — a step
 * assignee comes from the event payload and an HR Admin comes from a role
 * lookup, and no enum spans both. `text` is this module's, because the handbook
 * declares that templates carry i18n keys and never says what they say.
 *
 * Bodies interpolate `{{variable}}` and are never built by concatenation
 * (BR-NTF-006). The variable names are the sender's contract with the template;
 * where §4.2's Source column names the payload, they are taken from it, and an
 * unresolved placeholder is loud rather than silent (`render.ts`).
 */
export interface TemplateText {
  readonly title: string;
  readonly body: string;
}

export interface TemplateDefinition {
  readonly channels: readonly NotificationChannel[];
  /** BR-NTF-005 — preference-immune; toggling one is `NTF_TEMPLATE_MANDATORY`. */
  readonly mandatory: boolean;
  /** §4.2's Audience column, verbatim. Documentation for the sender. */
  readonly audience: string;
  readonly text: Readonly<Record<Locale, TemplateText>>;
}

const MANDATORY = true;
const OPTIONAL = false;

function define(
  channels: readonly NotificationChannel[],
  mandatory: boolean,
  audience: string,
  id: readonly [string, string],
  en: readonly [string, string],
): TemplateDefinition {
  return {
    channels,
    mandatory,
    audience,
    text: {
      id: { title: id[0], body: id[1] },
      en: { title: en[0], body: en[1] },
    },
  };
}

export const TEMPLATES: Readonly<Record<string, TemplateDefinition>> = {
  // ── approval ──────────────────────────────────────────────────────────────
  // The step events carry `assigneeUserIds` and `escalatedToUserIds` but not the
  // request type, so this copy names no request. Widening a §12 payload for
  // nicer wording is not a trade worth an upstream change; the deep link lands
  // the reader on the request itself.
  'approval.step_activated': define(
    ['in_app', 'push'],
    MANDATORY,
    'step assignees',
    ['Menunggu persetujuan Anda', 'Ada permintaan yang menunggu keputusan Anda.'],
    ['Waiting for your approval', 'A request is waiting for your decision.'],
  ),
  'approval.step_reminder': define(
    ['in_app', 'push'],
    MANDATORY,
    'assignees pending',
    ['Pengingat persetujuan', 'Permintaan ini masih menunggu keputusan Anda.'],
    ['Approval reminder', 'This request is still waiting for your decision.'],
  ),
  'approval.step_escalated': define(
    ['in_app', 'push', 'email'],
    MANDATORY,
    'escalation targets',
    [
      'Persetujuan dieskalasi',
      'Sebuah permintaan melewati batas waktu persetujuan dan dieskalasikan kepada Anda.',
    ],
    ['Approval escalated', 'A request passed its approval deadline and was escalated to you.'],
  ),
  // **The outcome is not a variable.** §4.2 asks for "approved/rejected/returned
  // + comment", and both are content: an outcome word passed as a parameter
  // would be rendered untranslated into a snapshot BR-NTF-006 freezes forever,
  // and a decision comment is free text with no length discipline. The frame is
  // localized and the deep link carries both — the shape announcement.md settled
  // on for the same reason.
  'approval.instance_decided': define(
    ['in_app', 'push'],
    MANDATORY,
    'requester (approved/rejected/returned + comment)',
    ['Permintaan Anda telah diputuskan', 'Buka permintaan untuk melihat hasil dan catatannya.'],
    [
      'Your request has been decided',
      "Open the request to see the outcome and the approver's note.",
    ],
  ),
  'approval.instance_stuck': define(
    ['in_app', 'email'],
    MANDATORY,
    'System Administrators (role audience)',
    [
      'Permintaan persetujuan macet',
      'Sebuah permintaan tidak menemukan penyetuju dan perlu diperbaiki.',
    ],
    ['Approval instance stuck', 'A request resolved to no approver and needs attention.'],
  ),

  // ── auth ──────────────────────────────────────────────────────────────────
  'auth.password_changed': define(
    ['email'],
    MANDATORY,
    'affected user',
    [
      'Kata sandi Anda diubah',
      'Kata sandi akun Anda baru saja diubah. Jika ini bukan Anda, hubungi administrator.',
    ],
    [
      'Your password was changed',
      'The password on your account was just changed. If this was not you, contact your administrator.',
    ],
  ),
  'auth.password_reset': define(
    ['email'],
    MANDATORY,
    'requesting user (carries the link)',
    ['Atur ulang kata sandi', 'Buka tautan berikut untuk mengatur ulang kata sandi Anda: {{link}}'],
    ['Reset your password', 'Open this link to reset your password: {{link}}'],
  ),
  'auth.invite': define(
    ['email'],
    MANDATORY,
    'invited user (carries the link)',
    [
      'Undangan akun',
      'Akun Anda sudah dibuat. Buka tautan berikut untuk mengatur kata sandi: {{link}}',
    ],
    [
      'Account invitation',
      'Your account has been created. Open this link to set your password: {{link}}',
    ],
  ),
  'auth.new_device_registered': define(
    ['email', 'push'],
    MANDATORY,
    'user (push to previous devices)',
    ['Perangkat baru terdaftar', 'Perangkat {{deviceLabel}} baru saja didaftarkan pada akun Anda.'],
    ['New device registered', 'The device {{deviceLabel}} was just registered on your account.'],
  ),
  'auth.device_revoked': define(
    ['push'],
    MANDATORY,
    'remaining active devices',
    ['Perangkat dicabut', 'Perangkat {{deviceLabel}} tidak lagi memiliki akses ke akun Anda.'],
    ['Device revoked', 'The device {{deviceLabel}} no longer has access to your account.'],
  ),
  'auth.replacement_blocked': define(
    ['in_app'],
    MANDATORY,
    'System Administrators',
    [
      'Penggantian perangkat tertahan',
      'Seorang pengguna meminta penggantian perangkat dan menunggu persetujuan administrator.',
    ],
    [
      'Device replacement blocked',
      'A user requested a device replacement and is waiting for administrator approval.',
    ],
  ),
  'auth.account_locked': define(
    ['email'],
    MANDATORY,
    'affected user',
    ['Akun terkunci', 'Akun Anda dikunci setelah beberapa kali percobaan masuk yang gagal.'],
    ['Account locked', 'Your account was locked after repeated failed sign-in attempts.'],
  ),

  // ── authz ─────────────────────────────────────────────────────────────────
  'authz.access_changed': define(
    ['in_app'],
    OPTIONAL,
    'affected user',
    ['Akses Anda berubah', 'Peran yang diberikan kepada Anda telah diperbarui.'],
    ['Your access changed', 'The roles assigned to you have been updated.'],
  ),

  // ── document-storage ──────────────────────────────────────────────────────
  'document.expiring': define(
    ['in_app', 'email'],
    MANDATORY,
    'HR Admins of the owning company',
    ['Dokumen akan kedaluwarsa', 'Dokumen {{category}} akan kedaluwarsa pada {{expiresOn}}.'],
    ['Document expiring', 'A {{category}} document expires on {{expiresOn}}.'],
  ),

  // ── import-export ─────────────────────────────────────────────────────────
  'import-export.import_finished': define(
    ['in_app', 'email'],
    OPTIONAL,
    'requester (completed / partially_completed / failed / auto-cancelled)',
    [
      'Impor selesai',
      'Impor {{importType}} selesai: {{applied}} baris diterapkan, {{failed}} gagal.',
    ],
    [
      'Import finished',
      'The {{importType}} import finished: {{applied}} rows applied, {{failed}} failed.',
    ],
  ),
  'import-export.export_finished': define(
    ['in_app'],
    OPTIONAL,
    'requester (link to job page; URL minted at click)',
    ['Ekspor siap', 'Berkas ekspor {{exportType}} sudah siap diunduh.'],
    ['Export ready', 'Your {{exportType}} export is ready to download.'],
  ),

  // ── employee ──────────────────────────────────────────────────────────────
  'employee.contract_expiring': define(
    ['in_app', 'email'],
    MANDATORY,
    'HR Admins of the owning company',
    ['Kontrak akan berakhir', 'Kontrak {{employeeName}} berakhir pada {{endDate}}.'],
    ['Contract expiring', "{{employeeName}}'s contract ends on {{endDate}}."],
  ),

  // ── shift ─────────────────────────────────────────────────────────────────
  'shift.roster_changed': define(
    ['in_app', 'push'],
    MANDATORY,
    'the affected employee',
    ['Jadwal Anda berubah', 'Jadwal kerja Anda mulai {{fromDate}} telah diperbarui.'],
    ['Your roster changed', 'Your working schedule from {{fromDate}} has been updated.'],
  ),

  // ── attendance ────────────────────────────────────────────────────────────
  'attendance.missing_clock_out': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee with an open punch',
    ['Belum absen pulang', 'Anda belum melakukan absen pulang untuk tanggal {{date}}.'],
    ['Missing clock-out', 'You have not clocked out for {{date}}.'],
  ),
  'attendance.punch_quarantined': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee who made the punch',
    ['Absensi tertahan', 'Absensi Anda pada {{date}} tertahan dan menunggu peninjauan HR.'],
    ['Punch quarantined', 'Your punch on {{date}} is held and waiting for HR review.'],
  ),

  // ── leave ─────────────────────────────────────────────────────────────────
  'leave.balance_expiring': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee holding the expiring days',
    ['Sisa cuti akan hangus', '{{days}} hari cuti Anda hangus pada {{expiresOn}}.'],
    ['Leave balance expiring', '{{days}} days of your leave balance expire on {{expiresOn}}.'],
  ),
  'leave.request_cancelled': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee whose approved leave was cancelled',
    ['Cuti Anda dibatalkan', 'Cuti Anda mulai {{fromDate}} dibatalkan. Alasan: {{reason}}'],
    [
      'Your leave was cancelled',
      'Your leave starting {{fromDate}} was cancelled. Reason: {{reason}}',
    ],
  ),

  // ── overtime ──────────────────────────────────────────────────────────────
  'overtime.acknowledgment_required': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee whose overtime was ordered on their behalf',
    ['Konfirmasi lembur', 'Lembur pada {{date}} diperintahkan untuk Anda dan menunggu konfirmasi.'],
    [
      'Overtime acknowledgment required',
      'Overtime on {{date}} was ordered for you and needs your acknowledgment.',
    ],
  ),
  'overtime.occurrence_actualized': define(
    ['in_app'],
    OPTIONAL,
    'the employee',
    [
      'Lembur disesuaikan',
      'Lembur {{date}} dihitung {{hours}} jam, berbeda dari yang diperintahkan.',
    ],
    [
      'Overtime actualized',
      'Overtime on {{date}} priced at {{hours}} hours, different from what was ordered.',
    ],
  ),

  // ── payroll ───────────────────────────────────────────────────────────────
  'payroll.payslip_published': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee',
    ['Slip gaji terbit', 'Slip gaji periode {{period}} sudah tersedia.'],
    ['Payslip published', 'Your payslip for {{period}} is available.'],
  ),
  'payroll.calculation_finished': define(
    ['in_app'],
    OPTIONAL,
    'the Payroll Admin who ran it',
    [
      'Perhitungan payroll selesai',
      'Perhitungan periode {{period}} selesai dengan {{errored}} baris bermasalah.',
    ],
    ['Payroll calculation finished', 'The {{period}} run finished with {{errored}} errored rows.'],
  ),
  'payroll.settlement_pending': define(
    ['in_app'],
    OPTIONAL,
    'Payroll Admins of the company',
    [
      'Final settlement menunggu',
      'Ada {{count}} karyawan keluar yang belum diselesaikan pembayarannya.',
    ],
    ['Settlement pending', '{{count}} departed employees have no final settlement yet.'],
  ),

  // ── tax ───────────────────────────────────────────────────────────────────
  'tax.form_issued': define(
    ['in_app', 'push'],
    MANDATORY,
    'the employee',
    [
      'Bukti potong terbit',
      'Formulir 1721-A1 tahun {{taxYear}} revisi {{revision}} sudah tersedia.',
    ],
    ['Tax form issued', 'Your 1721-A1 for {{taxYear}}, revision {{revision}}, is available.'],
  ),
  'tax.issuance_finished': define(
    ['in_app'],
    OPTIONAL,
    'the Payroll Admin who ran it',
    [
      'Penerbitan bukti potong selesai',
      'Tahun {{taxYear}}: {{issued}} diterbitkan, {{skipped}} dilewati.',
    ],
    ['Tax issuance finished', '{{taxYear}}: {{issued}} issued, {{skipped}} skipped.'],
  ),

  // ── expense-reimbursement ─────────────────────────────────────────────────
  // No amount in the body: the claim screen carries it, and a figure in a lock
  // screen preview is a salary-adjacent number read by whoever is standing there.
  'expense.claim_paid': define(
    ['in_app', 'push'],
    OPTIONAL,
    "the claim's employee",
    [
      'Klaim dibayarkan',
      'Klaim Anda dibayarkan melalui {{disburseVia}} dengan referensi {{paymentReference}}.',
    ],
    ['Claim paid', 'Your claim was paid via {{disburseVia}}, reference {{paymentReference}}.'],
  ),

  // ── asset ─────────────────────────────────────────────────────────────────
  'asset.assigned': define(
    ['in_app', 'push'],
    OPTIONAL,
    'the employee the asset was issued to',
    ['Aset diserahkan', '{{item}} tercatat diserahkan kepada Anda.'],
    ['Asset assigned', '{{item}} is recorded as handed over to you.'],
  ),
  'asset.clearance_pending': define(
    ['in_app'],
    MANDATORY,
    'holders of `asset.item.read` in the company (role audience)',
    [
      'Aset belum dikembalikan',
      '{{employeeName}} keluar dengan {{openCount}} aset yang masih tercatat.',
    ],
    [
      'Asset clearance pending',
      '{{employeeName}} is leaving with {{openCount}} assets still assigned.',
    ],
  ),

  // ── recruitment-candidate ─────────────────────────────────────────────────
  'recruitment.interview_assigned': define(
    ['in_app', 'email'],
    OPTIONAL,
    'the assigned panellist',
    ['Jadwal wawancara', 'Wawancara {{candidateName}} untuk {{requisitionTitle}} pada {{slot}}.'],
    [
      'Interview assigned',
      'Interview with {{candidateName}} for {{requisitionTitle}} at {{slot}}.',
    ],
  ),

  // ── performance-goals ─────────────────────────────────────────────────────
  'performance.cycle_launched': define(
    ['in_app', 'push'],
    OPTIONAL,
    'each newly created participant',
    [
      'Siklus penilaian dimulai',
      'Siklus {{cycleName}} dimulai. Sasaran ditetapkan paling lambat {{deadline}}.',
    ],
    [
      'Review cycle launched',
      'The {{cycleName}} cycle has started. Goals are due by {{deadline}}.',
    ],
  ),
  'performance.goals_submitted': define(
    ['in_app', 'push'],
    OPTIONAL,
    "the participant's pinned reviewer",
    ['Sasaran diajukan', '{{employeeName}} mengajukan {{goalCount}} sasaran untuk disepakati.'],
    ['Goals submitted', '{{employeeName}} submitted {{goalCount}} goals for agreement.'],
  ),
  'performance.self_review_due': define(
    ['in_app', 'push'],
    OPTIONAL,
    'the participant',
    ['Penilaian diri menunggu', 'Penilaian diri siklus {{cycleName}} ditutup {{deadline}}.'],
    ['Self review due', 'Your self review for {{cycleName}} closes on {{deadline}}.'],
  ),
  'performance.manager_review_due': define(
    ['in_app', 'push'],
    OPTIONAL,
    'the pinned reviewer',
    ['Penilaian atasan menunggu', 'Penilaian siklus {{cycleName}} ditutup {{deadline}}.'],
    ['Manager review due', 'The manager review for {{cycleName}} closes on {{deadline}}.'],
  ),
  // BR-PRF-016: the body carries no rating. A performance level rendered in an
  // inbox preview is a personnel outcome delivered by push notification.
  'performance.result_shared': define(
    ['in_app', 'push', 'email'],
    OPTIONAL,
    'the participant',
    ['Hasil penilaian tersedia', 'Hasil siklus {{cycleName}} sudah dapat Anda lihat.'],
    ['Review result shared', 'Your {{cycleName}} result is now available to you.'],
  ),

  // ── training ──────────────────────────────────────────────────────────────
  'training.enrollment_assigned': define(
    ['in_app', 'push', 'email'],
    MANDATORY,
    'the employee seated by HR',
    ['Anda didaftarkan pelatihan', '{{courseName}} mulai {{startDate}} di {{place}}.'],
    ['You were enrolled in training', '{{courseName}} starts {{startDate}} at {{place}}.'],
  ),
  'training.session_reminder': define(
    ['in_app', 'push'],
    OPTIONAL,
    'every `enrolled` seat on the session',
    ['Pengingat pelatihan', '{{courseName}} dimulai {{startDate}}.'],
    ['Training reminder', '{{courseName}} starts {{startDate}}.'],
  ),
  'training.session_cancelled': define(
    ['in_app', 'push', 'email'],
    MANDATORY,
    'every live enrollment on the cancelled session',
    ['Pelatihan dibatalkan', '{{courseName}} dibatalkan. Alasan: {{reason}}'],
    ['Training cancelled', '{{courseName}} was cancelled. Reason: {{reason}}'],
  ),
  'training.certification_expiring': define(
    ['in_app', 'email'],
    MANDATORY,
    'the credential holder and HR Admins of the company (role audience)',
    ['Sertifikasi akan berakhir', '{{credentialName}} berlaku sampai {{expiresOn}}.'],
    ['Certification expiring', '{{credentialName}} is valid until {{expiresOn}}.'],
  ),

  // ── announcement ──────────────────────────────────────────────────────────
  // The localized frame with the post's title as the only variable — how
  // free-form admin text passes a code-owned registry without becoming the one
  // send in the system with no locale and no i18n key. **The post's body is
  // never previewed**: it has no length discipline and its author does not know
  // who is standing next to the recipient when the phone lights up.
  'announcement.published': define(
    ['in_app', 'push'],
    OPTIONAL,
    'every recipient of the post',
    ['Pengumuman baru', '{{announcementTitle}}'],
    ['New announcement', '{{announcementTitle}}'],
  ),
  'announcement.acknowledgment_required': define(
    ['in_app', 'push'],
    MANDATORY,
    'every recipient of the post',
    ['Perlu konfirmasi', '{{announcementTitle}} — konfirmasi paling lambat {{acknowledgeBy}}.'],
    ['Acknowledgment required', '{{announcementTitle}} — please confirm by {{acknowledgeBy}}.'],
  ),

  // ── system-administration ─────────────────────────────────────────────────
  // BR-ADM-019, and mandatory for a reason §4.2 spells out: a tenant switching
  // this off would be switching off the only **push** signal that outside access
  // occurred, since the audit log is a pull surface BR-AUD-007 makes a sensitive
  // read in its own right. There is no end-of-session counterpart — the start
  // notice states the ceiling instead.
  'sysadmin.impersonation_started': define(
    ['in_app', 'email'],
    MANDATORY,
    'System Administrators of the entered tenant (role audience)',
    [
      'Akses dukungan dimulai',
      '{{operator}} masuk sebagai {{targetUser}} selama maksimal 30 menit. Alasan: {{reason}}',
    ],
    [
      'Support access started',
      '{{operator}} entered as {{targetUser}} for up to 30 minutes. Reason: {{reason}}',
    ],
  ),
};

/**
 * `null` for a key outside the registry — §8's `templateKey` validation.
 *
 * `Object.hasOwn` and not `TEMPLATES[key] ?? null`: a plain object literal
 * inherits `Object.prototype`, so `'constructor'` and `'toString'` are keys that
 * "exist" and return functions. The HTTP path is already bounded by the DTO's
 * `@IsIn`, but the port and the event handlers reach this with a string a
 * caller chose, and a template that is a function is a crash at render time.
 */
export function findTemplate(key: string): TemplateDefinition | null {
  return Object.hasOwn(TEMPLATES, key) ? (TEMPLATES[key] ?? null) : null;
}

/**
 * The owning namespace, for §7's matrix grouping. Derived from the key rather
 * than stored beside it: naming §4 makes the first segment the module's `ns`,
 * so a stored copy could only ever disagree with the key it sits on.
 */
export function templateModule(key: string): string {
  return key.slice(0, key.indexOf('.'));
}

/** §8's `channel` rule — *"declared by that template"*. */
export function declaresChannel(key: string, channel: NotificationChannel): boolean {
  return findTemplate(key)?.channels.includes(channel) ?? false;
}
