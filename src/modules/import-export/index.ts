// The import-export facade — the only import path other modules may use
// (ADR-0001 §1).
//
// **Nothing crosses this boundary as a port, and everything crosses it as a
// registration.** That is the inverse of every other platform module here, and
// it is what BR-IMP-001 asks for: a module does not *call* import-export, it
// *declares* an `ImportDefinition` or an `ExportDefinition` and the framework
// runs it. `registerImportDefinition` / `registerExportDefinition` are therefore
// the surface — the `registerFileOwner` and `registerAuditedTables` shape, one
// call in the owning module's file.
//
// A definition carries the module's own permission key, its natural key, its
// column contract, and the `rowHandler` or `queryPort` that does the work; none
// of those is this module's to decide, which is why §4.3's registry is a table
// of thirty rows owned elsewhere and this repository registers none of them yet.
//
// **`ValidateImportService`, `CommitImportService` and `ExportService` are not
// exported.** They are the seams the `imports` and `exports` queues will call,
// and those queues do not exist — ADR-0010 dispatches from a BullMQ worker this
// repository does not have. Exporting a concrete class through a facade for a
// caller that has not been written is also the one thing backend-nestjs §4 rules
// out. The processors get ports when there is a worker.

export { ImportExportModule } from './import-export.module';
export {
  registerExportDefinition,
  registerImportDefinition,
  type ColumnSets,
  type ColumnValidator,
  type CrossRowValidator,
  type ExportColumn,
  type ExportDefinition,
  type ExportQueryPort,
  type ExportRow,
  type GatedColumnSet,
  type ImportColumn,
  type ImportColumnType,
  type ImportDefinition,
  type ImportRowHandler,
  type ParamSpec,
  type ResolvedExport,
} from './domain/definitions';
export type {
  CellValue,
  ExportParams,
  LocalizedText,
  ParsedRow,
  RowError,
  RowVerdict,
} from './domain/import-export.types';
