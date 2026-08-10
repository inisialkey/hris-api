import type { TemplateDefinition } from './templates';
import type { Locale, TemplateParams } from './notification.types';

/**
 * BR-NTF-006 — one render, at send time, in the recipient's locale, and the
 * result is a snapshot. Nothing re-renders a stored row: a locale switch changes
 * what the next notification says and never what an old one said.
 *
 * Interpolation is `{{name}}` substitution over the template's own sentence, so
 * a translation moves its variables where its grammar needs them. Concatenating
 * a value onto a localized fragment is the thing BR-NTF-006 forbids, and it is
 * forbidden because word order is not universal.
 */
export interface RenderResult {
  title: string;
  body: string;
  /**
   * Placeholders the caller supplied no value for. §9's *"missing key/variable →
   * fallback + breadcrumb"*: the placeholder survives into the text so the gap is
   * visible rather than a blank, and the application layer logs it. A broken
   * variable never blocks a send — a security email with one wrong word beats no
   * security email.
   */
  unresolved: string[];
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function render(
  template: TemplateDefinition,
  locale: Locale,
  params: TemplateParams,
): RenderResult {
  // The `en` rung of §9's fallback chain. Unreachable while `text` is a total
  // map over `Locale` — which is the point of typing it that way — and kept
  // because a third locale would otherwise fail silently on the day it lands.
  const text = template.text[locale] ?? template.text.en;
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

  return {
    title: substitute(text.title),
    body: substitute(text.body),
    unresolved: [...unresolved],
  };
}
