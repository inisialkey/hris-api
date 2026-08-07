import type { ChainRow, Condition } from './approval.types';
import { evaluate, selectChain } from './chain-selection';

/**
 * BR-APRV-002 and §14's first row: *"company chain beats tenant chain; priority
 * order; condition ops; missing field → default"*.
 */
describe('chain selection (BR-APRV-002)', () => {
  const COMPANY = 'co-1';

  const chain = (over: Partial<ChainRow> & { id: string }): ChainRow => ({
    companyId: null,
    requestType: 'leave.request',
    name: over.id,
    priority: 100,
    conditions: null,
    steps: [],
    isActive: true,
    ...over,
  });

  it('prefers a company chain over a tenant chain of better priority', () => {
    const company = chain({ id: 'company', companyId: COMPANY, priority: 900 });
    const tenant = chain({ id: 'tenant', priority: 1 });

    expect(selectChain([tenant, company], COMPANY, {})?.id).toBe('company');
  });

  it('takes the lowest priority within a scope, first match wins', () => {
    const strict = chain({
      id: 'strict',
      priority: 10,
      conditions: [{ field: 'dayCount', op: 'gt', value: 5 }],
    });
    const fallback = chain({ id: 'default', priority: 100 });

    expect(selectChain([fallback, strict], COMPANY, { dayCount: 9 })?.id).toBe('strict');
    expect(selectChain([fallback, strict], COMPANY, { dayCount: 2 })?.id).toBe('default');
  });

  it('ignores an inactive chain even when it matches best', () => {
    const off = chain({ id: 'off', priority: 1, isActive: false });
    const on = chain({ id: 'on', priority: 100 });

    expect(selectChain([off, on], COMPANY, {})?.id).toBe('on');
  });

  it('breaks a priority tie by id rather than by row order', () => {
    const a = chain({ id: 'aaaa', priority: 50 });
    const b = chain({ id: 'bbbb', priority: 50 });

    expect(selectChain([b, a], COMPANY, {})?.id).toBe('aaaa');
    expect(selectChain([a, b], COMPANY, {})?.id).toBe('aaaa');
  });

  it('returns null when nothing matches — the APRV_NO_CHAIN_CONFIGURED case', () => {
    const conditional = chain({
      id: 'x',
      conditions: [{ field: 'isPaid', op: 'eq', value: true }],
    });
    expect(selectChain([conditional], COMPANY, { isPaid: false })).toBeNull();
  });

  it('falls through to the default when the context omits a condition field', () => {
    // ADR-0008's accepted tradeoff, restated in §9: a missing field is false,
    // not an error. The module gets the safe chain rather than a failed submit.
    const conditional = chain({
      id: 'conditional',
      priority: 1,
      conditions: [{ field: 'balanceAfter', op: 'lt', value: 0 }],
    });
    const fallback = chain({ id: 'default', priority: 100 });

    expect(selectChain([conditional, fallback], COMPANY, {})?.id).toBe('default');
  });
});

describe('condition operators (§7 op set)', () => {
  const check = (condition: Condition, context: Record<string, unknown>) =>
    evaluate(condition, context);

  it('compares numbers written as strings', () => {
    // A `numeric` column arrives from Postgres as '5.00' while an admin types 5.
    expect(check({ field: 'total', op: 'gte', value: 5 }, { total: '5.00' })).toBe(true);
    expect(check({ field: 'total', op: 'gt', value: 5 }, { total: '5.00' })).toBe(false);
  });

  it('handles every ordering op', () => {
    const context = { n: 10 };
    expect(check({ field: 'n', op: 'gt', value: 9 }, context)).toBe(true);
    expect(check({ field: 'n', op: 'gte', value: 10 }, context)).toBe(true);
    expect(check({ field: 'n', op: 'lt', value: 11 }, context)).toBe(true);
    expect(check({ field: 'n', op: 'lte', value: 10 }, context)).toBe(true);
  });

  it('matches eq/neq on strings and booleans', () => {
    expect(check({ field: 'g', op: 'eq', value: 'bank' }, { g: 'bank' })).toBe(true);
    expect(check({ field: 'g', op: 'neq', value: 'bank' }, { g: 'contact' })).toBe(true);
    expect(check({ field: 'paid', op: 'eq', value: true }, { paid: true })).toBe(true);
    expect(check({ field: 'paid', op: 'eq', value: true }, { paid: false })).toBe(false);
  });

  it('reads `in` against the condition value list', () => {
    const condition: Condition = { field: 'code', op: 'in', value: ['sick', 'unpaid'] };
    expect(check(condition, { code: 'unpaid' })).toBe(true);
    expect(check(condition, { code: 'annual' })).toBe(false);
  });

  it('refuses to order values that have no ordering', () => {
    // `[object Object] > 5` must never decide who approves a payroll run.
    expect(check({ field: 'x', op: 'gt', value: 5 }, { x: { a: 1 } })).toBe(false);
    expect(check({ field: 'x', op: 'gt', value: true }, { x: false })).toBe(false);
  });

  it('orders ISO dates lexically, which is why the registry declares no types', () => {
    expect(check({ field: 'd', op: 'gte', value: '2026-03-01' }, { d: '2026-03-02' })).toBe(true);
    expect(check({ field: 'd', op: 'lt', value: '2026-03-01' }, { d: '2026-02-28' })).toBe(true);
  });
});
