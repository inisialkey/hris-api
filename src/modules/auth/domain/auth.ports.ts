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
  refreshTokenHash: string;
  trustedDevice: boolean;
  ip: string;
  userAgent?: string;
  expiresAt: Date;
}

export const AUTH_LOOKUP_REPOSITORY = Symbol('AUTH_LOOKUP_REPOSITORY');

/** The pre-tenant lookup path (authentication.md §4). */
export interface AuthLookupRepositoryPort {
  findCandidatesByEmail(email: string): Promise<CandidateUser[]>;
  findTenants(ids: readonly string[]): Promise<TenantSummary[]>;
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

export interface SessionRepositoryPort {
  create(session: NewSession): Promise<string>;
  stampLastLogin(userId: string): Promise<void>;
}
