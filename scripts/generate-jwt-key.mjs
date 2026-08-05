import { generateKeyPairSync } from 'node:crypto';

/**
 * Mints one Ed25519 pair for local development (A-014).
 *
 * In staging and production the pair lives in Secret Manager and rotates every
 * 90 days (environments.md §5). This script exists so that a laptop does not
 * need that machinery, and so that nobody is tempted to commit a key "just for
 * dev" — the two lines it prints go in `.env`, which is gitignored.
 */
const kid = process.argv[2] ?? 'local-1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const oneLine = (pem) => pem.trimEnd().replace(/\n/g, '\\n');

process.stdout.write(`JWT_ACTIVE_KID=${kid}\n`);
process.stdout.write(`JWT_PRIVATE_KEY="${oneLine(pkcs8)}"\n`);
process.stdout.write(`JWT_PUBLIC_KEYS='${JSON.stringify({ [kid]: spki })}'\n`);
