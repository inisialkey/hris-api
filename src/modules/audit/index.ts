// The audit facade — the only import path other modules may use (ADR-0001 §1).
//
// One port crosses this boundary, and it only writes. Reading the log is an
// HTTP concern (§7) until reports arrives with `AuditQueryPort` (§4.4), which is
// specified but has no caller yet and is therefore not built.

export { AuditModule } from './audit.module';
export { AUDIT_PORT, type AuditPort, type AuditDiff } from './domain/audit.ports';
