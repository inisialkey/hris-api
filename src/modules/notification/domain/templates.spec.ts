import { TEMPLATES, declaresChannel, findTemplate, templateModule } from './templates';

const KEY = /^[a-z][a-z-]*\.[a-z][a-z_]*$/;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * The registry is transcribed data, so these are transcription tests: they catch
 * a row that lost a locale, a key that stopped matching naming §4's grammar, and
 * a translation pair whose variables drifted apart — the three ways a table this
 * shape goes wrong silently.
 */
describe('template registry (§4.2, BR-NTF-001)', () => {
  const entries = Object.entries(TEMPLATES);

  it('carries the whole seed table', () => {
    // A count, not a list: the list is the file. This fails when a row is added
    // or removed without anyone deciding to, which is the only thing a number
    // can usefully assert about a transcription.
    expect(entries).toHaveLength(45);
  });

  it.each(entries)('%s is well formed', (key, template) => {
    expect(key).toMatch(KEY);
    expect(template.channels.length).toBeGreaterThan(0);
    expect(new Set(template.channels).size).toBe(template.channels.length);
    expect(template.audience.length).toBeGreaterThan(0);

    for (const locale of ['id', 'en'] as const) {
      expect(template.text[locale].title.trim().length).toBeGreaterThan(0);
      expect(template.text[locale].body.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(entries)('%s asks both locales for the same variables', (_key, template) => {
    // A translation that dropped a placeholder renders a sentence missing its
    // value; one that invented a placeholder renders `{{x}}` forever, because no
    // sender knows to supply it.
    expect(variables(template.text.en)).toEqual(variables(template.text.id));
  });

  it('derives the module from the key rather than storing it', () => {
    expect(templateModule('approval.step_activated')).toBe('approval');
    expect(templateModule('import-export.import_finished')).toBe('import-export');
  });

  it('answers §8’s channel rule from the template that declares it', () => {
    expect(declaresChannel('approval.step_activated', 'push')).toBe(true);
    expect(declaresChannel('approval.step_activated', 'email')).toBe(false);
    expect(declaresChannel('not.registered', 'push')).toBe(false);
  });

  it('returns null for a key outside the registry', () => {
    expect(findTemplate('not.registered')).toBeNull();
    expect(findTemplate('constructor')).toBeNull();
  });

  it('keeps the security and statutory templates preference-immune', () => {
    // BR-NTF-005's own examples: security notices, approval actionables and
    // statutory documents. A regression here is a tenant switching off the only
    // signal that their password changed.
    for (const key of [
      'auth.password_changed',
      'auth.account_locked',
      'approval.step_activated',
      'payroll.payslip_published',
      'tax.form_issued',
      'sysadmin.impersonation_started',
    ]) {
      expect(TEMPLATES[key]?.mandatory).toBe(true);
    }
  });

  it('leaves the templates a person is entitled to mute optional', () => {
    for (const key of [
      'announcement.published',
      'training.session_reminder',
      'authz.access_changed',
      'expense.claim_paid',
    ]) {
      expect(TEMPLATES[key]?.mandatory).toBe(false);
    }
  });
});

function variables(text: { title: string; body: string }): string[] {
  return [...`${text.title} ${text.body}`.matchAll(PLACEHOLDER)].map((match) => match[1]!).sort();
}
