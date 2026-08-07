// The document-storage facade — the only import path other modules may use
// (ADR-0001 §1).
//
// Two things cross this boundary and they point in opposite directions.
//
// `StorageUsagePort` is what leaves: §13's one served port, counts and bytes and
// nothing else, for the platform-health page. Every other consumer of document
// metadata goes through the signed-URL flow, which is where the sensitive-read
// trail lives — that is why there is no `DocumentPort` here. Four module
// documents name one (`announcement.md`, `training.md`, `expense-reimbursement.md`,
// `asset.md`), none declares its shape, and none of them exists yet; a port
// whose methods only its first caller can define is the one employee withheld
// as `EmployeePayrollPort`, for the same reason (A-195).
//
// `registerFileOwner` is what arrives: the authorization half of §4.2's registry,
// supplied by the module that owns a category. One call in the owning module
// file, the `registerAuditedTables` shape, because §4.2's protocol is that the
// module owning a category binds its keys and its resolver.

export { DocumentModule } from './document.module';
export { STORAGE_USAGE_PORT, type StorageUsagePort } from './domain/document.ports';
export { registerFileOwner, type FileOwner } from './domain/categories';
export type { EntityRef, FileRow } from './domain/document.types';
