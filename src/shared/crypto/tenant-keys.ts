import { requireTenantContext } from '../context';

/**
 * The per-tenant key cache ADR-0016 decision 4 calls for — *"cached decrypted
 * in-process with short TTL"* — and the reason it is a module-level map rather
 * than an injected service.
 *
 * A Drizzle `customType`'s `toDriver`/`fromDriver` are **synchronous** and take
 * no context. That is not negotiable: it is the mechanism ADR-0016 decision 2
 * chose, so that *"repositories encrypt/decrypt transparently"*. Unwrapping a
 * DEK is an async KMS call, so the only way both facts hold is for the key to be
 * resolved **before** the query and read synchronously during it. Hence:
 * `TenantKeyService.ensureLoaded()` fills this map on the async path, and the
 * column type reads it on the sync one, keyed by the AsyncLocalStorage tenant.
 *
 * A miss **throws**. It is the fail-closed direction: a repository that forgot
 * to load the key stops, rather than writing a column in the clear or reading a
 * `v1:` string into a domain object as though it were a NIK.
 */

export interface TenantKeys {
  /** AES-256-GCM data key for the encrypted set. */
  readonly dek: Buffer;
  /** HMAC key for `nik_bidx` / `npwp_bidx` — independently rotatable (ADR-0016 §3). */
  readonly indexKey: Buffer;
  /** Matches the `v<n>:` prefix new ciphertext is written with. */
  readonly dekVersion: number;
}

/**
 * Five minutes. Long enough that a request pays one unwrap rather than one per
 * repository call, short enough that a crypto-shred (a deleted `tenant_keys`
 * row) stops being served well inside the window an operator would wait anyway.
 */
export const TENANT_KEY_TTL_MS = 300_000;

const cache = new Map<string, { keys: TenantKeys; expiresAt: number }>();

export class MissingTenantKeysError extends Error {
  constructor(tenantId: string) {
    super(`no decrypted key material loaded for tenant ${tenantId}`);
  }
}

export function cacheTenantKeys(tenantId: string, keys: TenantKeys, now: number): void {
  cache.set(tenantId, { keys, expiresAt: now + TENANT_KEY_TTL_MS });
}

export function cachedTenantKeys(tenantId: string, now: number): TenantKeys | null {
  const entry = cache.get(tenantId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(tenantId);
    return null;
  }
  return entry.keys;
}

/** Called by the column type. `Date.now()` is fine here — this is a cache, not a business rule. */
export function currentTenantKeys(): TenantKeys {
  const { tenantId } = requireTenantContext();
  const keys = cachedTenantKeys(tenantId, Date.now());
  if (!keys) throw new MissingTenantKeysError(tenantId);
  return keys;
}

/** Test seam, and the hook a future rotation job calls after re-wrapping. */
export function forgetTenantKeys(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}
