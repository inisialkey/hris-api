import type { Locale, TitleParams } from './inbox.types';

/**
 * The item copy, and it is this module's rather than the handbook's.
 *
 * notification.md carries a forty-five row registry in §4.2 with an i18n key per
 * template; inbox.md carries none, and BR-INB-005 nonetheless says titles
 * *"render once at creation in the recipient's locale"*. So the strings live
 * here, on the precedent A-198 set for notification's message text: the document
 * fixes that a title is rendered and frozen, and nothing anywhere says what it
 * says. Both locales ship per D12 (`locale.ts` explains why every V1 render is
 * still `id`), and a translation pair whose placeholders drift apart fails a
 * test rather than rendering a sentence missing its value.
 *
 * **The variables are `REQUEST_TYPE_CONTEXT_FIELDS`, not new vocabulary.** Each
 * subtitle interpolates a field the request type already declares to the chain
 * editor (approval-engine §13), so nothing here invents a fact a module has to
 * start sending. `training.enrollment` has no subtitle for exactly that reason —
 * its declared fields are all ids, and a uuid is not a subtitle.
 */
export interface TitleTemplate {
  title: Record<Locale, string>;
  subtitle: Record<Locale, string> | null;
}

function define(
  idTitle: string,
  enTitle: string,
  subtitle?: readonly [string, string],
): TitleTemplate {
  return {
    title: { id: idTitle, en: enTitle },
    subtitle: subtitle ? { id: subtitle[0], en: subtitle[1] } : null,
  };
}

/**
 * UC-INB-001's title, one entry per approval-engine §13 request type. The title
 * names the act and its requester — the two things that make a task list
 * scannable — and the subtitle carries the one context field an approver decides
 * on, which is the *"3 days"* of the use case's own example.
 */
export const APPROVAL_TASK_TITLES: Readonly<Record<string, TitleTemplate>> = {
  'leave.request': define(
    'Pengajuan cuti · {{requesterName}}',
    'Leave request · {{requesterName}}',
    ['{{dayCount}} hari', '{{dayCount}} days'],
  ),
  'overtime.request': define(
    'Pengajuan lembur · {{requesterName}}',
    'Overtime request · {{requesterName}}',
    ['{{plannedHours}} jam', '{{plannedHours}} hours'],
  ),
  'attendance.correction': define(
    'Koreksi absensi · {{requesterName}}',
    'Attendance correction · {{requesterName}}',
    ['{{date}}', '{{date}}'],
  ),
  'expense.claim': define(
    'Klaim reimbursement · {{requesterName}}',
    'Expense claim · {{requesterName}}',
    // The line count rather than `totalAmount`: money crosses the wire as a
    // decimal string (ADR-0007) and formatting IDR is the client's job, so a
    // frozen subtitle is the one place it must not be attempted.
    ['{{lineCount}} baris', '{{lineCount}} lines'],
  ),
  'employee.data_change': define(
    'Perubahan data karyawan · {{requesterName}}',
    'Employee data change · {{requesterName}}',
    ['{{fieldGroup}}', '{{fieldGroup}}'],
  ),
  'employee.resignation': define(
    'Pengunduran diri · {{requesterName}}',
    'Resignation · {{requesterName}}',
    ['{{lastDay}}', '{{lastDay}}'],
  ),
  'recruitment.requisition': define(
    'Permintaan rekrutmen · {{requesterName}}',
    'Hiring requisition · {{requesterName}}',
    ['{{openings}} lowongan', '{{openings}} openings'],
  ),
  'recruitment.offer': define(
    'Penawaran kerja · {{requesterName}}',
    'Job offer · {{requesterName}}',
    // `revisionNumber` is the field recruitment-candidate.md §13 says turns
    // negotiation into a control; an approver seeing "Revisi 3" is the point.
    ['Revisi {{revisionNumber}}', 'Revision {{revisionNumber}}'],
  ),
  payroll_run: define('Proses payroll · {{requesterName}}', 'Payroll run · {{requesterName}}', [
    '{{employeeCount}} karyawan',
    '{{employeeCount}} employees',
  ]),
  'training.enrollment': define(
    'Pendaftaran pelatihan · {{requesterName}}',
    'Training enrollment · {{requesterName}}',
  ),
};

/**
 * UC-INB-005's item. `subject` is the one variable the caller supplies, and the
 * port's doc comment is where that contract is stated — announcement.md fixes
 * that `titleParams` exists and not what is in it, because this module renders
 * and that module has no copy of its own here.
 */
export const ACKNOWLEDGMENT_TITLE = define(
  'Perlu konfirmasi baca · {{subject}}',
  'Acknowledgment required · {{subject}}',
);

/**
 * `null` for a request type with no entry, which the registry test makes
 * unreachable for every type approval-engine §13 registers. `Object.hasOwn`
 * rather than a bare index because the key reaching here is whatever the engine
 * stored in `request_type`, and a plain object literal inherits
 * `Object.prototype` — `titleFor('constructor')` would otherwise return a
 * function.
 */
export function titleFor(requestType: string): TitleTemplate | null {
  return Object.hasOwn(APPROVAL_TASK_TITLES, requestType)
    ? (APPROVAL_TASK_TITLES[requestType] ?? null)
    : null;
}

export interface RenderedTitle {
  title: string;
  subtitle: string | null;
  /**
   * Placeholders the caller supplied no value for. The placeholder survives into
   * the text so the gap is visible rather than blank, and the application layer
   * logs the names — notification's §9 breadcrumb rule, and for the same reason:
   * a task with one wrong word beats no task in the approver's list.
   */
  unresolved: string[];
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function renderTitle(
  template: TitleTemplate,
  locale: Locale,
  params: TitleParams,
): RenderedTitle {
  const unresolved = new Set<string>();

  const substitute = (source: string): string =>
    source.replace(PLACEHOLDER, (placeholder, name: string) => {
      const value = params[name];
      if (value === undefined) {
        unresolved.add(name);
        return placeholder;
      }
      return String(value);
    });

  const subtitle = template.subtitle?.[locale] ?? template.subtitle?.en;

  return {
    title: substitute(template.title[locale] ?? template.title.en),
    subtitle: subtitle === undefined ? null : substitute(subtitle),
    unresolved: [...unresolved],
  };
}
