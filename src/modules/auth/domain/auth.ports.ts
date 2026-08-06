/**
 * Repository interfaces, in `domain/` where backend-nestjs §3 puts them.
 *
 * Ports are `Symbol` tokens plus interfaces, never concrete classes, so that
 * extracting this module later swaps the provider for an HTTP or queue adapter
 * without touching a single consumer (ADR-0001 readiness criterion c).
 */

export interface CandidateUser {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  status: 'active' | 'inactive' | 'locked';
}

export interface TenantSummary {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
}

export interface NewSession {
  tenantId: string;
  userId: string;
  deviceId?: string;
  refreshTokenHash: string;
  trustedDevice: boolean;
  ip: string;
  userAgent?: string;
  expiresAt: Date;
}

/** A `sessions` row as the refresh flow needs it (BR-AUTH-006 inputs). */
export interface SessionRecord {
  id: string;
  tenantId: string;
  userId: string;
  deviceId: string | null;
  trustedDevice: boolean;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/** An `auth_tokens` row as the consuming flows need it (BR-AUTH-010). */
export interface AuthTokenRecord {
  id: string;
  tenantId: string;
  userId: string;
  purpose: 'password_reset' | 'invite';
  expiresAt: Date;
  usedAt: Date | null;
}

export const AUTH_LOOKUP_REPOSITORY = Symbol('AUTH_LOOKUP_REPOSITORY');

/**
 * The pre-tenant lookup path (authentication.md §4): the four SELECTs that run
 * before a tenant context exists, under `SET LOCAL ROLE hris_auth`.
 */
export interface AuthLookupRepositoryPort {
  findCandidatesByEmail(email: string): Promise<CandidateUser[]>;
  findTenants(ids: readonly string[]): Promise<TenantSummary[]>;
  findSessionByRefreshHash(refreshTokenHash: string): Promise<SessionRecord | null>;
  findAuthTokenByHash(tokenHash: string): Promise<AuthTokenRecord | null>;
}

/** `sessions.revoked_reason` vocabulary (authentication.md §4). */
export type SessionRevokedReason =
  | 'logout'
  | 'user'
  | 'admin'
  | 'device_revoked'
  | 'token_reuse'
  | 'password_change'
  | 'password_reset';

export interface SessionListRow {
  id: string;
  deviceSummary: string | null;
  ip: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  trustedDevice: boolean;
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

/** Session rows, always under the resolved tenant's context. */
export interface SessionRepositoryPort {
  create(session: NewSession): Promise<string>;
  stampLastLogin(userId: string): Promise<void>;
  findById(sessionId: string): Promise<SessionRecord | null>;
  /** Rotation: new hash in, `last_used_at` bumped (BR-AUTH-004). */
  rotate(sessionId: string, newRefreshTokenHash: string, now: Date): Promise<void>;
  /** `false` = already revoked (the idempotent no-op of UC-AUTH-003/004). */
  revoke(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<boolean>;
  /** Revoked session ids, so the caller can emit one event per session (§12). */
  revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    now: Date,
    exceptSessionId?: string,
  ): Promise<string[]>;
  revokeForDevice(deviceId: string, now: Date): Promise<string[]>;
  listForUser(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: SessionListRow[]; total: number }>;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  installId: string;
  platform: 'android' | 'ios';
  fcmToken: string | null;
  status: 'active' | 'revoked';
}

export interface NewDevice {
  tenantId: string;
  userId: string;
  installId: string;
  platform: 'android' | 'ios';
  model: string;
  osVersion: string;
  appVersion: string;
  fcmToken?: string;
}

export interface DeviceListRow {
  id: string;
  platform: 'android' | 'ios';
  model: string;
  osVersion: string;
  appVersion: string;
  status: 'active' | 'revoked';
  lastSeenAt: Date | null;
  createdAt: Date;
}

export const DEVICE_REPOSITORY = Symbol('DEVICE_REPOSITORY');

/** Device registry rows (ADR-0004), under the resolved tenant's context. */
export interface DeviceRepositoryPort {
  /** Any status: a revoked install must be *seen* to be refused (§7 login). */
  findByInstallId(installId: string): Promise<DeviceRecord | null>;
  findById(deviceId: string): Promise<DeviceRecord | null>;
  countActiveForUser(userId: string): Promise<number>;
  create(device: NewDevice, now: Date): Promise<string>;
  /** Re-login on a known install: version fields, FCM token, `last_seen_at`. */
  touch(
    deviceId: string,
    updates: { model: string; osVersion: string; appVersion: string; fcmToken?: string },
    now: Date,
  ): Promise<void>;
  updateFcmToken(deviceId: string, fcmToken: string, now: Date): Promise<void>;
  /** `false` = already revoked. Drops the FCM token in the same statement (UC-AUTH-005). */
  revoke(deviceId: string, reason: 'replaced' | 'user' | 'admin', now: Date): Promise<boolean>;
  listForUser(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: DeviceListRow[]; total: number }>;
}

export const AUTH_TOKEN_REPOSITORY = Symbol('AUTH_TOKEN_REPOSITORY');

/** Reset and invite tokens (BR-AUTH-010), under the resolved tenant's context. */
export interface AuthTokenRepositoryPort {
  create(token: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    purpose: 'password_reset' | 'invite';
    expiresAt: Date;
    createdBy?: string;
  }): Promise<string>;
  /**
   * Sets `used_at` where it is still NULL — the single-use check lives in the
   * consuming transaction's row lock, not in a read that races (§4 invariant).
   * `false` = someone else consumed it first.
   */
  consume(tokenId: string, now: Date): Promise<boolean>;
}

export interface UserAccountRecord {
  id: string;
  email: string;
  passwordHash: string;
  status: 'active' | 'inactive' | 'locked';
}

export const USER_ACCOUNT_REPOSITORY = Symbol('USER_ACCOUNT_REPOSITORY');

/** The auth-owned writes to `users`, under the resolved tenant's context. */
export interface UserAccountRepositoryPort {
  findById(userId: string): Promise<UserAccountRecord | null>;
  setPasswordHash(userId: string, passwordHash: string, actorId: string): Promise<void>;
  /** `locked` → `active` (BR-AUTH-013). `false` = user absent or not locked. */
  unlock(userId: string, actorId: string): Promise<boolean>;
}

export const AUTH_OUTBOX = Symbol('AUTH_OUTBOX');

/**
 * The §12 events, into the `domain_events` outbox in the caller's transaction
 * (ADR-0010). Payloads are pointers and primitives — never a token, never PII.
 */
export interface AuthOutboxPort {
  emit(event: {
    name: 'auth.session.revoked' | 'auth.device.revoked' | 'auth.password.changed';
    tenantId: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
