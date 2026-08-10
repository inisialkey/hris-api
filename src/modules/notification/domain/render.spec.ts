import { render } from './render';
import type { TemplateDefinition } from './templates';

const template: TemplateDefinition = {
  channels: ['in_app'],
  mandatory: false,
  audience: 'test',
  text: {
    id: { title: 'Halo {{name}}', body: '{{count}} berkas menunggu sampai {{date}}.' },
    en: { title: 'Hello {{name}}', body: '{{count}} files waiting until {{date}}.' },
  },
};

describe('render (BR-NTF-006)', () => {
  it('substitutes every placeholder in the recipient locale', () => {
    const result = render(template, 'id', { name: 'Sari', count: 3, date: '2026-09-01' });

    expect(result.title).toBe('Halo Sari');
    expect(result.body).toBe('3 berkas menunggu sampai 2026-09-01.');
    expect(result.unresolved).toEqual([]);
  });

  it('renders the same variables into a different sentence for a different locale', () => {
    // The point of placeholders over concatenation: word order is not universal,
    // and each translation places its own values.
    const result = render(template, 'en', { name: 'Sari', count: 3, date: '2026-09-01' });

    expect(result.title).toBe('Hello Sari');
    expect(result.body).toBe('3 files waiting until 2026-09-01.');
  });

  it('leaves a missing variable visible and names it, rather than blanking it', () => {
    // §9 — a broken variable never blocks a send; the gap is loud instead.
    const result = render(template, 'id', { name: 'Sari' });

    expect(result.title).toBe('Halo Sari');
    expect(result.body).toBe('{{count}} berkas menunggu sampai {{date}}.');
    expect(result.unresolved).toEqual(['count', 'date']);
  });

  it('reports a variable missing from both title and body once', () => {
    const result = render(
      { ...template, text: { ...template.text, id: { title: '{{x}}', body: '{{x}}' } } },
      'id',
      {},
    );

    expect(result.unresolved).toEqual(['x']);
  });

  it('renders a numeric zero rather than treating it as absent', () => {
    const result = render(template, 'id', { name: 'Sari', count: 0, date: '2026-09-01' });

    expect(result.body).toBe('0 berkas menunggu sampai 2026-09-01.');
    expect(result.unresolved).toEqual([]);
  });

  it('ignores a parameter no placeholder asks for', () => {
    const result = render(template, 'id', {
      name: 'Sari',
      count: 1,
      date: '2026-09-01',
      extra: 'unused',
    });

    expect(result.unresolved).toEqual([]);
    expect(result.title).toBe('Halo Sari');
  });
});
