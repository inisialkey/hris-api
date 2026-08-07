import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { open, seal } from './aead';
import type { KeyProvider } from './key-provider.port';

/** The one KEK generation a local provider has. Cloud KMS supplies real ones. */
const LOCAL_KEK_VERSION = 'local-1';

/**
 * `environments.md` §5's local KEK, behind the ADR-0016 port.
 *
 * **It refuses to load outside `local` and `test`**, and that refusal is the
 * whole point of the class: a KEK sitting in an environment variable is
 * appropriate on a laptop and is a breach anywhere a real employee's NIK exists.
 * The registry row says *"`local` only"* and was written for the `api` process;
 * `test` is added here because `ADR-0020` decision 1 declares it part of the
 * closed `APP_ENV` set for CI-ephemeral containers, and an integration test
 * proving that ciphertext lands in the column needs to actually encrypt. What
 * matters — that `staging` and `production` cannot reach this provider — is
 * unchanged. Recorded as A-195.
 */
@Injectable()
export class LocalKeyProvider implements KeyProvider {
  private readonly kek: Buffer;

  constructor(config: ConfigService) {
    const env = config.get<string>('APP_ENV');
    if (env !== 'local' && env !== 'test') {
      throw new Error(`LocalKeyProvider refuses to load with APP_ENV=${String(env)}`);
    }

    const raw = config.get<string>('LOCAL_KEK');
    if (!raw) throw new Error('LOCAL_KEK is required when APP_ENV is local or test');

    const kek = Buffer.from(raw, 'base64');
    if (kek.length !== 32) throw new Error('LOCAL_KEK must decode to 32 bytes');
    this.kek = kek;
  }

  activeKekVersion(): string {
    return LOCAL_KEK_VERSION;
  }

  wrap(plaintext: Buffer): Promise<string> {
    return Promise.resolve(seal(this.kek, plaintext.toString('base64'), 1));
  }

  unwrap(wrapped: string, kekVersion: string): Promise<Buffer> {
    if (kekVersion !== LOCAL_KEK_VERSION) {
      throw new Error(`unknown KEK version ${kekVersion}`);
    }
    return Promise.resolve(Buffer.from(open(this.kek, wrapped), 'base64'));
  }
}
