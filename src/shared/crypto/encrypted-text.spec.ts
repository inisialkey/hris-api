import { randomBytes } from 'node:crypto';

import { blindIndex, digitsOnly } from './encrypted-text';

describe('blind index (BR-EMP-004, ADR-0016 §3)', () => {
  const indexKey = randomBytes(32);

  it('is deterministic within a tenant — which is what makes the unique constraint work', () => {
    expect(blindIndex(indexKey, '3201234567890001')).toBe(blindIndex(indexKey, '3201234567890001'));
  });

  it('differs across tenants for the same NIK', () => {
    // ADR-0016's stated leak boundary: equality is visible *within* a tenant,
    // where NIK is unique anyway, and invisible across them.
    expect(blindIndex(indexKey, '3201234567890001')).not.toBe(
      blindIndex(randomBytes(32), '3201234567890001'),
    );
  });

  it('normalises to digits, so a typed separator is not a second person', () => {
    expect(blindIndex(indexKey, '3201 2345 6789 0001')).toBe(
      blindIndex(indexKey, '3201234567890001'),
    );
    expect(blindIndex(indexKey, '32.0123456789.0001')).toBe(
      blindIndex(indexKey, '3201234567890001'),
    );
  });

  it('distinguishes different values', () => {
    expect(blindIndex(indexKey, '3201234567890001')).not.toBe(
      blindIndex(indexKey, '3201234567890002'),
    );
  });

  it('strips every non-digit', () => {
    expect(digitsOnly('09.876.543.2-109.000')).toBe('098765432109000');
  });
});
