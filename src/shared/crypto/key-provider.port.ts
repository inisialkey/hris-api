/**
 * ADR-0016 decision 4 — envelope encryption.
 *
 * One KMS-held master KEK wraps a per-tenant DEK and index key; the wrapped
 * material lives in `tenant_keys` and the plaintext keys never touch the
 * database. This port is the KMS seam the ADR names — "portable behind a
 * `KeyProvider` port" — so the local development provider and a Cloud KMS
 * provider differ in one binding and nowhere else.
 *
 * It lives in `shared/` because ADR-0016's consequences say so outright:
 * *"`KeyProvider` port lands in `shared/`… crypto helpers are platform code,
 * whitelisted per ADR-0001."* No addition to the ADR-0001 rule 4 whitelist is
 * needed — it was written into ADR-0016 before there was a caller.
 */

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

export interface KeyProvider {
  /** The KEK generation new material is wrapped under (`tenant_keys.kek_version`). */
  activeKekVersion(): string;
  /**
   * Wraps freshly generated key material. Provisioning's call
   * (system-administration.md BR-ADM-005); until that module ships, `seed-dev`
   * and the integration harness are the only callers.
   */
  wrap(plaintext: Buffer): Promise<string>;
  /**
   * Unwraps under the KEK version the material was wrapped with. A KEK version
   * is disabled rather than destroyed (backup-restore §11), so an old version
   * still unwraps.
   */
  unwrap(wrapped: string, kekVersion: string): Promise<Buffer>;
}
