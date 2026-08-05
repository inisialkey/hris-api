import { readFileSync } from 'node:fs';

/**
 * C12 (banned dependencies) and part of C13 (handbook-managed regions) —
 * ci-cd.md §5.
 *
 * C13's manifest has three rows. Only the `Result` one is implemented here,
 * because it is the only one this repository has a marker for and the only one
 * whose source is an ADR rather than the CLAUDE.md template. The `CLAUDE.md` and
 * `docs/agents/domain.md` rows are a bootstrap concern shared by all three
 * repositories and belong in one place rather than three; this file does not
 * pretend to cover them.
 */

const failures = [];

// ---- C12: banned dependencies (CLAUDE.md's must-NOT column) ----------------
// Every entry is one line of a table somebody would otherwise have to remember.
const BANNED = ['prisma', '@prisma/client', 'typeorm', 'mikro-orm', '@mikro-orm/core'];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
for (const name of BANNED) {
  if (name in declared) failures.push(`C12: banned dependency \`${name}\` is declared (ADR-0013)`);
}

// ---- C13: the ADR-0006 canonical Result block ------------------------------
const MARKER = '// ---- ADR-0006 canonical, nothing above this line ----';
const adr = readFileSync('docs/handbook/docs/adr/ADR-0006-result-pattern-error-handling.md', 'utf8');
const canonical = /```ts\n([\s\S]*?)```/.exec(adr)?.[1];

if (!canonical) {
  failures.push('C13: could not find the canonical TypeScript block in ADR-0006');
} else {
  const local = readFileSync('src/shared/result.ts', 'utf8');
  const markerAt = local.indexOf(MARKER);
  if (markerAt < 0) {
    failures.push(`C13: src/shared/result.ts has no \`${MARKER}\` marker`);
  } else {
    // Byte equality above the marker. The marker is what lets this be an
    // equality test rather than a judgement call — the sanctioned combinators
    // live below it and are none of this check's business.
    const region = local.slice(0, markerAt);
    if (!region.includes(canonical.trimEnd())) {
      failures.push('C13: src/shared/result.ts diverges from ADR-0006 above the marker');
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`${f}\n`);
  process.exit(1);
}

process.stdout.write(`handbook-check: C12 clean (${BANNED.length} names), C13 Result region matches\n`);
