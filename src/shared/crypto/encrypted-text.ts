import { createHmac } from 'node:crypto';
import { customType } from 'drizzle-orm/pg-core';

import { open, seal } from './aead';
import { currentTenantKeys } from './tenant-keys';

/**
 * ADR-0016 decision 2's column type: *"a Drizzle custom column type
 * (`encryptedText`) so repositories encrypt/decrypt transparently; domain and
 * API layers see plaintext strings"*.
 *
 * Two things follow from it being a custom type rather than a helper a
 * repository remembers to call, and both are load-bearing elsewhere:
 *
 * - **A column cannot be written in the clear by accident.** There is no code
 *   path that assigns to `employees.nik` without passing through `toDriver`.
 * - **The audit diff masks it for free.** BR-AUD-005 layer 1 derives masking
 *   from `columnType === 'PgCustomColumn'`, which is what this produces, so an
 *   encrypted column records that it changed and never what it changed to —
 *   with no list for anyone to forget to update.
 */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    const keys = currentTenantKeys();
    return seal(keys.dek, value, keys.dekVersion);
  },
  fromDriver(value: string): string {
    return open(currentTenantKeys().dek, value);
  },
});

/**
 * BR-EMP-004 / ADR-0016 decision 3 — `HMAC-SHA256(tenant index key,
 * digits-only value)`.
 *
 * Normalisation is digits-only because that is what the ADR says and because
 * the alternative leaks: an NIK typed with spaces and the same NIK typed
 * without would otherwise be two different people to the uniqueness constraint
 * that exists to say they are one.
 *
 * Exact-match only, by design. There is no partial or prefix search over an
 * encrypted field anywhere in the product — admin search uses name and employee
 * number, which is why `employee_directory` carries exactly those two.
 */
export function blindIndex(indexKey: Buffer, value: string): string {
  return createHmac('sha256', indexKey).update(digitsOnly(value)).digest('hex');
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}
