import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { ConnectionProvider } from '../../database/connection.provider';
import { tenantKeys } from '../../database/schema';
import { CLOCK, type Clock } from '../clock.port';
import { requireTenantContext } from '../context';
import { KEY_PROVIDER, type KeyProvider } from './key-provider.port';
import { cacheTenantKeys, cachedTenantKeys, currentTenantKeys } from './tenant-keys';

/**
 * The async half of ADR-0016's key path: read the wrapped material, unwrap it
 * through the KMS seam, and leave the plaintext keys in the process cache the
 * `encryptedText` column type reads synchronously.
 *
 * Every repository touching an encrypted column calls `ensureLoaded()` first.
 * That is one explicit line rather than an interceptor, because most requests
 * touch no encrypted column at all and an eager unwrap on the guard chain would
 * charge a KMS round trip to every attendance punch in the system.
 *
 * `tenant_keys` is **platform-class** — no RLS policy (system-administration.md
 * §4.1) — so this read needs no tenant predicate and works on the pool handle
 * as well as inside a unit-of-work.
 */
@Injectable()
export class TenantKeyService {
  constructor(
    private readonly connection: ConnectionProvider,
    @Inject(KEY_PROVIDER) private readonly provider: KeyProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async ensureLoaded(): Promise<void> {
    const { tenantId } = requireTenantContext();
    const now = this.clock.now().getTime();
    if (cachedTenantKeys(tenantId, now)) return;

    const rows = await this.connection
      .handle()
      .select()
      .from(tenantKeys)
      .where(eq(tenantKeys.tenantId, tenantId));

    const row = rows[0];
    if (!row) {
      // A tenant with no key row cannot hold employee identity data at all.
      // Loud, because the alternative — writing NIK in the clear — is the
      // failure ADR-0016 exists to prevent.
      throw new Error(`tenant ${tenantId} has no tenant_keys row`);
    }

    // Sequential, never `Promise.all`: this may run inside a unit-of-work, and
    // one transaction is one socket (coding-standards-nestjs §4).
    const dek = await this.provider.unwrap(row.wrappedDek, row.kekVersion);
    const indexKey = await this.provider.unwrap(row.wrappedIndexKey, row.kekVersion);

    cacheTenantKeys(tenantId, { dek, indexKey, dekVersion: row.dekVersion }, now);
  }

  /** BR-EMP-004's HMAC key. Loading is the caller's precondition, restated here. */
  async indexKey(): Promise<Buffer> {
    await this.ensureLoaded();
    return currentTenantKeys().indexKey;
  }
}
