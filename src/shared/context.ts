import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The two request-scoped contexts of multi-tenancy §1. Both immutable after
 * construction, both carried by AsyncLocalStorage, both built in exactly three
 * places: the HTTP guard chain, the worker job wrapper, and the platform-op
 * helper. Business code never constructs one.
 *
 * "Immutable after construction" and "assembled across the guard chain" are both
 * true, and a box is what reconciles them. The middleware at chain position 1
 * opens one scope for the whole request; the guards that follow *replace* the
 * context inside it rather than mutating a field. So a reader always sees a
 * frozen object, and the request still accumulates identity as it is proven —
 * which is what actually happens between positions 1 and 5 of backend-nestjs §5.
 */

export type TenantContextSource = 'jwt' | 'job' | 'impersonation' | 'platform-op';

export interface TenantContext {
  readonly tenantId: string;
  readonly source: TenantContextSource;
  /** Platform user id, present only while impersonating (ADR-0002). */
  readonly impersonatorId?: string;
}

/** `all`, or the explicit company-id list from ADR-0005 assignment resolution. */
export type CompanyScope = 'all' | readonly string[];

export interface ResolvedAuthorization {
  readonly permissions: ReadonlySet<string>;
  readonly companyScope: CompanyScope;
}

/**
 * Resolution is lazy (ADR-0005, amended 2026-08-04). An `@AuthenticatedOnly()`
 * route has no key to check, so it must not pay for a lookup — which matters
 * because every employee self-service route is one of those, the cache is keyed
 * per user, and an employee appears about twice a day, so every eager lookup on
 * the hottest path in the system was a guaranteed miss.
 */
export interface AuthorizationHandle {
  resolve(): Promise<ResolvedAuthorization>;
}

export interface RequestContext {
  readonly requestId: string;
  /** `undefined` = system actor (job, migration, sync fan-out). */
  readonly userId?: string;
  readonly sessionId?: string;
  readonly authorization?: AuthorizationHandle;
}

interface ContextBox {
  tenant?: TenantContext;
  request?: RequestContext;
}

const store = new AsyncLocalStorage<ContextBox>();

/** Opens the scope. One call per request (middleware) or per job (job wrapper). */
export function runInContextScope<T>(initial: ContextBox, fn: () => T): T {
  return store.run({ ...initial }, fn);
}

function box(): ContextBox {
  const current = store.getStore();
  if (!current) throw new Error('no context scope open');
  return current;
}

export function setTenantContext(ctx: TenantContext): void {
  box().tenant = Object.freeze({ ...ctx });
}

export function setRequestContext(ctx: RequestContext): void {
  box().request = Object.freeze({ ...ctx });
}

export function currentTenantContext(): TenantContext | undefined {
  return store.getStore()?.tenant;
}

export function currentRequestContext(): RequestContext | undefined {
  return store.getStore()?.request;
}

/**
 * For code that cannot proceed without a tenant. Callers that merely *read* are
 * better off letting RLS return zero rows — fail-closed is the design (ADR-0002),
 * and an exception here would only turn a silent-correct into a loud-correct.
 */
export function requireTenantContext(): TenantContext {
  const ctx = currentTenantContext();
  if (!ctx) throw new Error('no TenantContext in scope');
  return ctx;
}

export function requireRequestContext(): RequestContext {
  const ctx = currentRequestContext();
  if (!ctx) throw new Error('no RequestContext in scope');
  return ctx;
}
