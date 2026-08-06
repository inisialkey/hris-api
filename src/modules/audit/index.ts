// The audit facade — the only import path other modules may use (ADR-0001 §1).
//
// Two ports cross this boundary, and both only write. Reading the log is an
// HTTP concern (§7) until reports arrives with `AuditQueryPort` (§4.4), which is
// specified but has no caller yet and is therefore not built.

export { AuditModule } from './audit.module';
export {
  AUDIT_CHANGE_PORT,
  AUDIT_PORT,
  type AuditChange,
  type AuditChangePort,
  type AuditDiff,
  type AuditPort,
} from './domain/audit.ports';
// The §4.2 registry's write side. Not a port — a module registering its own
// audited tables is declaring what it owns, the `registerErrorStatuses` shape.
export {
  assertAuditedTable,
  registerAuditedTables,
  type AuditedTableEntry,
} from './domain/audited-tables';
