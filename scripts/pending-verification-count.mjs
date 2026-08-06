// G20's counter (testing-strategy §13, ADR-0018 §5): print the number of
// statutory vectors still pending human verification, per calculator and in
// total. Informational in this workflow — the count blocks *release promotion*
// for the calculators a release exposes, never a merge, and no promotion
// pipeline exists yet. Exit code is always 0 here; the promotion gate, when it
// arrives, reads the same files and enforces the zero.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'test', 'vectors');
const files = readdirSync(dir).filter((f) => f.endsWith('.statutory.json'));

let total = 0;
for (const file of files) {
  const { vectors } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const pending = vectors.filter((v) => v.status === 'pending-verification').length;
  total += pending;
  process.stdout.write(`G20: ${file} — ${pending}/${vectors.length} pending-verification\n`);
}
process.stdout.write(`G20: total pending-verification vectors: ${total}\n`);
