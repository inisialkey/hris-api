import { randomBytes } from 'node:crypto';

import { runInContextScope, setTenantContext } from '../context';
import {
  MissingTenantKeysError,
  TENANT_KEY_TTL_MS,
  cacheTenantKeys,
  cachedTenantKeys,
  currentTenantKeys,
  forgetTenantKeys,
} from './tenant-keys';

describe('tenant key cache', () => {
  const t1 = 'tenant-one';
  const keys = { dek: randomBytes(32), indexKey: randomBytes(32), dekVersion: 1 };

  afterEach(() => {
    forgetTenantKeys();
  });

  function inTenant<T>(tenantId: string, fn: () => T): T {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      return fn();
    });
  }

  it('serves a loaded tenant synchronously — the whole reason it exists', () => {
    cacheTenantKeys(t1, keys, Date.now());
    expect(inTenant(t1, () => currentTenantKeys().dek)).toEqual(keys.dek);
  });

  it('throws rather than serving nothing when the key was never loaded', () => {
    // Fail-closed. The alternative is a repository writing NIK in the clear
    // because a caller forgot `ensureLoaded()`.
    expect(() => inTenant(t1, () => currentTenantKeys())).toThrow(MissingTenantKeysError);
  });

  it('never serves one tenant’s key under another tenant’s context', () => {
    cacheTenantKeys(t1, keys, Date.now());
    expect(() => inTenant('tenant-two', () => currentTenantKeys())).toThrow(MissingTenantKeysError);
  });

  it('expires at the TTL boundary rather than after it', () => {
    cacheTenantKeys(t1, keys, 1_000);
    expect(cachedTenantKeys(t1, 1_000 + TENANT_KEY_TTL_MS - 1)).not.toBeNull();
    expect(cachedTenantKeys(t1, 1_000 + TENANT_KEY_TTL_MS)).toBeNull();
  });

  it('forgets a single tenant without clearing the rest', () => {
    cacheTenantKeys(t1, keys, 0);
    cacheTenantKeys('tenant-two', keys, 0);
    forgetTenantKeys(t1);
    expect(cachedTenantKeys(t1, 0)).toBeNull();
    expect(cachedTenantKeys('tenant-two', 0)).not.toBeNull();
  });
});
