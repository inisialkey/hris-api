import { REQUEST_TYPES, contextFieldsOf } from '../../approval';
import { APPROVAL_TASK_TITLES, ACKNOWLEDGMENT_TITLE, renderTitle, titleFor } from './titles';

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function variables(...sources: readonly (string | undefined)[]): Set<string> {
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of (source ?? '').matchAll(PLACEHOLDER)) found.add(match[1]!);
  }
  return found;
}

/**
 * The copy is transcribed data, so these are transcription tests. Two of them
 * are load-bearing rather than hygiene: the coverage test is what makes
 * `titleFor`'s `null` branch unreachable in practice, and the context test is
 * what stops a subtitle interpolating a field no module ever sends.
 */
describe('inbox item titles (BR-INB-005)', () => {
  const entries = Object.entries(APPROVAL_TASK_TITLES);

  it('covers every request type the engine registers', () => {
    // approval-engine §13 is the registry; a type added there without copy here
    // would ship a task titled with its own machine key.
    expect(new Set(Object.keys(APPROVAL_TASK_TITLES))).toEqual(new Set(REQUEST_TYPES));
  });

  it.each(entries)('%s is well formed', (_type, template) => {
    for (const locale of ['id', 'en'] as const) {
      expect(template.title[locale].trim().length).toBeGreaterThan(0);
      if (template.subtitle) expect(template.subtitle[locale].trim().length).toBeGreaterThan(0);
    }
  });

  it.each(entries)('%s asks both locales for the same variables', (_type, template) => {
    // A translation that dropped a placeholder renders a title missing its
    // value; one that invented a placeholder renders `{{x}}` forever, because no
    // sender knows to supply it.
    expect(variables(template.title.en, template.subtitle?.en)).toEqual(
      variables(template.title.id, template.subtitle?.id),
    );
  });

  it.each(entries)('%s interpolates only declared context fields', (type, template) => {
    // `requesterName` comes from `ApprovalTaskPort`; everything else must be a
    // field approval-engine §13 declares for that request type, or the subtitle
    // renders a placeholder nobody can ever fill.
    const declared = new Set([...contextFieldsOf(type), 'requesterName']);
    for (const name of variables(template.title.id, template.subtitle?.id)) {
      expect(declared).toContain(name);
    }
  });

  it('renders both halves and reports what it could not fill', () => {
    const rendered = renderTitle(APPROVAL_TASK_TITLES['leave.request']!, 'id', {
      requesterName: 'Budi Santoso',
    });

    expect(rendered.title).toBe('Pengajuan cuti · Budi Santoso');
    // The placeholder survives into the text so the gap is visible rather than
    // blank, and the name is reported so the application layer can log it.
    expect(rendered.subtitle).toBe('{{dayCount}} hari');
    expect(rendered.unresolved).toEqual(['dayCount']);
  });

  it('renders a null subtitle as null, not as an empty string', () => {
    const rendered = renderTitle(APPROVAL_TASK_TITLES['training.enrollment']!, 'id', {
      requesterName: 'Sari',
    });
    expect(rendered.subtitle).toBeNull();
  });

  it('renders the acknowledgment title from the caller’s subject', () => {
    const rendered = renderTitle(ACKNOWLEDGMENT_TITLE, 'id', { subject: 'Libur Idulfitri' });
    expect(rendered.title).toBe('Perlu konfirmasi baca · Libur Idulfitri');
    expect(rendered.unresolved).toEqual([]);
  });

  it('returns null for a request type outside the registry', () => {
    expect(titleFor('not.registered')).toBeNull();
    // A plain object literal inherits `Object.prototype`, and the key reaching
    // here is whatever the engine stored in `request_type`.
    expect(titleFor('constructor')).toBeNull();
  });
});
