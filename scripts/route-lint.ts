import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * ADR-0005: every route declares `@RequirePermission()`, `@Public()`, or
 * `@AuthenticatedOnly()`. **A route with none is a build failure, not a silent
 * pass** — deny by default, structurally.
 *
 * This is the check that makes that sentence true. Without it the rule is a
 * convention, and a convention is what a new module forgets on a Friday.
 *
 * Text-based on purpose. A TypeScript AST pass would be more precise and would
 * need the compiler API, a program, and a tsconfig resolution step to answer a
 * question that is one decorator wide. The precision it buys is precision about
 * code nobody writes: decorators here are always literal and always adjacent.
 */

const HTTP_DECORATORS = /^\s*@(Get|Post|Patch|Put|Delete|All|Head|Options)\s*\(/;
const MARKERS = /@(RequirePermission|Public|AuthenticatedOnly)\s*\(/;
const METHOD_SIGNATURE =
  /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\(/;

interface Violation {
  file: string;
  line: number;
  method: string;
}

function scan(file: string): Violation[] {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('@Controller(')) return [];

  const lines = source.split('\n');
  const violations: Violation[] = [];

  let pending: string[] = [];
  let routeLine = -1;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();

    if (trimmed.startsWith('@')) {
      pending.push(trimmed);
      if (HTTP_DECORATORS.test(line)) routeLine = index + 1;
      continue;
    }

    // Blank lines and comments sit between decorators without ending the block.
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*')
    ) {
      continue;
    }

    if (routeLine !== -1) {
      const signature = METHOD_SIGNATURE.exec(line);
      if (signature) {
        const decorators = pending.join('\n');
        if (!MARKERS.test(decorators)) {
          violations.push({ file, line: routeLine, method: signature[1] ?? '?' });
        }
      }
    }

    pending = [];
    routeLine = -1;
  }

  return violations;
}

const files = globSync('src/**/*.ts');
const violations = files.flatMap(scan);

if (violations.length > 0) {
  for (const v of violations) {
    process.stderr.write(
      `${v.file}:${v.line} route handler \`${v.method}\` declares no @RequirePermission, @Public or @AuthenticatedOnly (ADR-0005)\n`,
    );
  }
  process.stderr.write(`\n${violations.length} undeclared route(s)\n`);
  process.exit(1);
}

const routeCount = files
  .map((f) => readFileSync(f, 'utf8'))
  .filter((s) => s.includes('@Controller('))
  .reduce((n, s) => n + (s.match(new RegExp(HTTP_DECORATORS.source, 'gm')) ?? []).length, 0);

process.stdout.write(`route-lint: ${routeCount} routes, all declared\n`);
