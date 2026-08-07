// The auth facade — the only import path other modules may use (ADR-0001 §1).
//
// The two guards are exported because `AppModule` registers them globally, which
// is the whole chain's wiring point. `AccountLifecyclePort` (authentication.md
// §13) landed 2026-08-06 with the employee module, its only consumer.

export { AuthModule } from './auth.module';
export { ACCESS_TOKEN_SERVICE, type AccessTokenPort } from './application/ports/auth-services.port';
export { ACCOUNT_LIFECYCLE_PORT, type AccountLifecyclePort } from './domain/auth.ports';
export { JwtAuthGuard } from './presentation/jwt-auth.guard';
export { TenantStatusGuard } from './presentation/tenant-status.guard';
