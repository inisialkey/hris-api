// The document-storage facade — the only import path other modules may use
// (ADR-0001 §1).
//
// Two things cross this boundary and they point in opposite directions.
//
// `StorageUsagePort` is what leaves: §13's one served port, counts and bytes and
// nothing else, for the platform-health page.
//
// `DocumentPort` **arrived 2026-08-10 with its first caller**
// (A-200, hris-handbook PR #34). The note
// that stood here said four module documents name one, none declares its shape,
// and none of them exists — the `EmployeePayrollPort` line of A-195. That held
// exactly until a module needed UC-DOC-004, the worker write path: import-export
// generates an error workbook and an export output and reads back an uploaded
// one, and those four methods are defined precisely by that use case rather than
// guessed. Client access is untouched and still runs through the signed-URL
// flow, which is where the gate and the sensitive-read trail live.
//
// `registerFileOwner` is what arrives: the authorization half of §4.2's registry,
// supplied by the module that owns a category. One call in the owning module
// file, the `registerAuditedTables` shape, because §4.2's protocol is that the
// module owning a category binds its keys and its resolver.

export { DocumentModule } from './document.module';
export {
  DOCUMENT_PORT,
  STORAGE_USAGE_PORT,
  type DocumentPort,
  type GeneratedFileCommand,
  type StorageUsagePort,
} from './domain/document.ports';
export { registerFileOwner, type FileOwner } from './domain/categories';
export type { EntityRef, FileRow } from './domain/document.types';
