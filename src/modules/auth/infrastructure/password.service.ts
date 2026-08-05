import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';

import type { PasswordPort } from '../application/ports/auth-services.port';

/**
 * argon2id at security-standards §2's platform-fixed parameters: memory 64 MiB,
 * iterations 3, parallelism 4. Not tenant-tunable and not a settings key — a
 * tenant lowering its own hashing cost is not a configuration option.
 */
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * A hash of a value nobody knows, computed once at boot.
 *
 * BR-AUTH-002 requires unknown email and wrong password to be indistinguishable
 * — same code *and* statistically indistinguishable timing. Returning early on
 * an unknown email skips the argon2 work and turns a 200 ms difference into an
 * account-enumeration oracle, so the unknown path verifies against this instead.
 */
const DUMMY_PASSWORD = 'not-a-password-and-never-will-be';

@Injectable()
export class PasswordService implements PasswordPort {
  private dummyHash: Promise<string> | undefined;

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, PARAMS);
  }

  async verify(storedHash: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, PARAMS);
    } catch {
      // A malformed stored hash is a data defect, not a successful login.
      return false;
    }
  }

  /** Burn the same CPU the real path would have burned. */
  async verifyDummy(plaintext: string): Promise<void> {
    this.dummyHash ??= hash(DUMMY_PASSWORD, PARAMS);
    await this.verify(await this.dummyHash, plaintext);
  }
}
