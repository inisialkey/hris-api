/**
 * Out-ports for the things a use case needs but must not reach for directly.
 *
 * The layer rule is not decoration here: it is what let the login use case be
 * unit-tested without a database, a Redis, an argon2 binary, or an ESM-only JWT
 * library — the last of which is what surfaced the violation in the first place.
 */

export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  sid: string;
  typ: 'access';
}

export const PASSWORD_SERVICE = Symbol('PASSWORD_SERVICE');

export interface PasswordPort {
  hash(plaintext: string): Promise<string>;
  verify(storedHash: string, plaintext: string): Promise<boolean>;
  /** Burn the same CPU a real verify would, on the unknown-email path. */
  verifyDummy(plaintext: string): Promise<void>;
}

export const LOGIN_ATTEMPT_SERVICE = Symbol('LOGIN_ATTEMPT_SERVICE');

export interface LoginAttemptPort {
  /** `retryAfterSeconds` when locked, `null` when the attempt may proceed. */
  check(email: string): Promise<number | null>;
  recordFailure(email: string): Promise<void>;
  recordSuccess(email: string): Promise<void>;
}

export const ACCESS_TOKEN_SERVICE = Symbol('ACCESS_TOKEN_SERVICE');

export interface AccessTokenPort {
  sign(claims: AccessTokenClaims): Promise<{ token: string; expiresInSeconds: number }>;
  verify(token: string): Promise<AccessTokenClaims | null>;
}

export const TENANT_TRANSACTION = Symbol('TENANT_TRANSACTION');

/**
 * Opens a tenant-scoped unit of work from inside a use case.
 *
 * Business code normally never does this — `TransactionInterceptor` owns it at
 * chain position 7 (backend-nestjs §8.1). Login is the exception, and it is a
 * structural one rather than an oversight: the route is `@Public()`, so there is
 * no tenant to scope by until the credential has been checked against every
 * tenant that holds the email. The port exists so that the exception is a named
 * contract instead of an import that quietly breaks the layer rule.
 */
export const TENANT_STATUS_PORT = Symbol('TENANT_STATUS_PORT');

export interface TenantTransactionPort {
  runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

export interface TenantStatusPort {
  /** `'missing'` when no such tenant exists — a stale or forged token. */
  status(tenantId: string): Promise<string>;
}

export const IDENTITY_QUERY = Symbol('IDENTITY_QUERY');

export interface IdentityQueryPort {
  findUser(userId: string): Promise<{ email: string } | null>;
  findTenant(tenantId: string): Promise<{ id: string; name: string; status: string } | null>;
}
