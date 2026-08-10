/**
 * Fakes and builders shared by this module's use-case specs.
 *
 * Hand-written in-memory doubles rather than mocks — coding-standards-nestjs §9
 * asks for exactly that at the use-case layer, and a fake that stores rows
 * catches the things a mock cannot: a status guard that reads before it writes,
 * a resume cursor that advances, an entitlement frozen at the wrong moment.
 */

import { Readable, Writable } from 'node:stream';

import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import { ok, type Result } from '../../../shared/result';
import type { EntityRef, FileRow } from '../../document';
import type { ExportDefinition, ImportDefinition, ImportColumn } from '../domain/definitions';
import type {
  ExportJobPatch,
  ExportJobRepositoryPort,
  ImportJobFilter,
  ImportJobPatch,
  ImportJobRepositoryPort,
} from '../domain/import-export.ports';
import type {
  ExportJobParams,
  ExportJobRow,
  ExportJobStatus,
  ImportJobRow,
  ImportJobStatus,
  Page,
  Paged,
} from '../domain/import-export.types';

export const TENANT = '018f2f4a-0000-7000-8000-0000000a0001';
export const NOW = new Date('2026-08-10T03:00:00Z');
export const clock = { now: () => NOW };

export function inScope<T>(
  userId: string | undefined,
  permissions: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return runInContextScope({}, () => {
    setTenantContext({ tenantId: TENANT, source: 'jwt' });
    setRequestContext({
      requestId: 'request-1',
      userId,
      authorization: {
        resolve: () =>
          Promise.resolve({ permissions: new Set(permissions), companyScope: 'all' as const }),
      },
    });
    return fn();
  });
}

export const text = (value: string) => ({ id: value, en: value });

export function columns(): ImportColumn[] {
  return [
    { key: 'nik', header: text('NIK'), type: 'string', required: true, example: '3201…' },
    { key: 'name', header: text('Nama'), type: 'string', required: true },
    { key: 'joinDate', header: text('Tanggal masuk'), type: 'date', required: true },
  ];
}

export function importDefinition(overrides: Partial<ImportDefinition> = {}): ImportDefinition {
  return {
    key: 'employee.master',
    requiredPermission: 'employee.master.import',
    templateVersion: 1,
    columns: columns(),
    naturalKey: ['nik'],
    writeMode: 'create_only',
    commitMode: 'partial',
    rowHandler: { apply: () => Promise.resolve(ok(undefined) as Result<void>) },
    ...overrides,
  };
}

export function exportDefinition(overrides: Partial<ExportDefinition> = {}): ExportDefinition {
  return {
    key: 'employee.master',
    requiredPermission: 'employee.master.export',
    params: [{ key: 'companyId', type: 'uuid', required: true }],
    columnSets: {
      base: [
        { key: 'number', header: text('Nomor') },
        { key: 'name', header: text('Nama') },
      ],
      gated: [
        { permission: 'employee.sensitive.read', columns: [{ key: 'nik', header: text('NIK') }] },
      ],
    },

    queryPort: { stream: async function* () {} },
    ...overrides,
  };
}

let sequence = 0;
const nextId = () => `id-${(sequence += 1)}`;

export class FakeImportJobs implements ImportJobRepositoryPort {
  readonly rows = new Map<string, ImportJobRow>();

  seed(row: Partial<ImportJobRow> & Pick<ImportJobRow, 'type' | 'status'>): ImportJobRow {
    const job: ImportJobRow = {
      id: row.id ?? nextId(),
      fileId: row.fileId ?? 'file-1',
      errorReportFileId: row.errorReportFileId ?? null,
      templateVersion: row.templateVersion ?? null,
      totalRows: row.totalRows ?? null,
      validRows: row.validRows ?? null,
      errorRows: row.errorRows ?? null,
      appliedRows: row.appliedRows ?? null,
      lastCommittedBatch: row.lastCommittedBatch ?? null,
      failureCode: row.failureCode ?? null,
      requestedBy: row.requestedBy ?? 'user-a',
      confirmedBy: row.confirmedBy ?? null,
      confirmedAt: row.confirmedAt ?? null,
      completedAt: row.completedAt ?? null,
      createdAt: row.createdAt ?? NOW,
      ...row,
    };
    this.rows.set(job.id, job);
    return job;
  }

  insertIfNoneActive(type: string, fileId: string): Promise<ImportJobRow | null> {
    const active = [...this.rows.values()].find(
      (row) => row.type === type && ACTIVE.has(row.status),
    );
    if (active) return Promise.resolve(null);
    return Promise.resolve(this.seed({ type, status: 'uploaded', fileId }));
  }

  findActive(type: string): Promise<ImportJobRow | null> {
    return Promise.resolve(
      [...this.rows.values()].find((row) => row.type === type && ACTIVE.has(row.status)) ?? null,
    );
  }

  findById(id: string): Promise<ImportJobRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  list(filter: ImportJobFilter, page: Page): Promise<Paged<ImportJobRow>> {
    const rows = [...this.rows.values()].filter(
      (row) =>
        (!filter.type || row.type === filter.type) &&
        (!filter.status || row.status === filter.status),
    );
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }

  update(id: string, patch: ImportJobPatch): Promise<ImportJobRow | null> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve(null);
    const updated = { ...row, ...patch };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  staleAwaitingConfirmation(confirmedBefore: Date, limit: number): Promise<ImportJobRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.status === 'awaiting_confirmation' && row.createdAt < confirmedBefore)
        .slice(0, limit),
    );
  }

  cancelIfAwaiting(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'awaiting_confirmation') return Promise.resolve(false);
    this.rows.set(id, { ...row, status: 'cancelled', completedAt: at });
    return Promise.resolve(true);
  }

  confirmIfAwaiting(id: string, by: string | undefined, at: Date): Promise<ImportJobRow | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'awaiting_confirmation') return Promise.resolve(null);
    const updated: ImportJobRow = {
      ...row,
      status: 'committing',
      confirmedBy: by ?? null,
      confirmedAt: at,
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  terminalCreatedBefore(cutoff: Date, limit: number): Promise<ImportJobRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => TERMINAL.has(row.status) && row.createdAt < cutoff)
        .slice(0, limit),
    );
  }

  deleteById(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

export class FakeExportJobs implements ExportJobRepositoryPort {
  readonly rows = new Map<string, ExportJobRow>();

  seed(row: Partial<ExportJobRow> & Pick<ExportJobRow, 'type'>): ExportJobRow {
    const job: ExportJobRow = {
      id: row.id ?? nextId(),
      status: row.status ?? 'queued',
      params: row.params ?? { _columns: [], _gated: false },
      fileId: row.fileId ?? null,
      rowCount: row.rowCount ?? null,
      failureCode: row.failureCode ?? null,
      requestedBy: row.requestedBy ?? 'user-a',
      completedAt: row.completedAt ?? null,
      createdAt: row.createdAt ?? NOW,
      ...row,
    };
    this.rows.set(job.id, job);
    return job;
  }

  insert(type: string, params: ExportJobParams): Promise<ExportJobRow> {
    return Promise.resolve(this.seed({ type, params, status: 'queued' }));
  }

  findById(id: string): Promise<ExportJobRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  list(
    filter: { type?: string; status?: ExportJobStatus },
    page: Page,
  ): Promise<Paged<ExportJobRow>> {
    const rows = [...this.rows.values()].filter(
      (row) =>
        (!filter.type || row.type === filter.type) &&
        (!filter.status || row.status === filter.status),
    );
    return Promise.resolve({
      rows: rows.slice(page.offset, page.offset + page.limit),
      total: rows.length,
    });
  }

  update(id: string, patch: ExportJobPatch): Promise<ExportJobRow | null> {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve(null);
    const updated = { ...row, ...patch };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  terminalCreatedBefore(cutoff: Date, limit: number): Promise<ExportJobRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            (row.status === 'completed' || row.status === 'failed') && row.createdAt < cutoff,
        )
        .slice(0, limit),
    );
  }

  deleteById(id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

/** A `DocumentPort` whose bucket is a Map and whose rows are objects. */
export class FakeDocuments {
  readonly files = new Map<string, FileRow>();
  readonly written = new Map<string, Buffer>();
  readonly softDeleted: string[] = [];
  content: Buffer | null = null;

  seedFile(row: Partial<FileRow> & Pick<FileRow, 'id'>): FileRow {
    const file: FileRow = {
      module: 'import-export',
      entityType: 'user',
      entityId: 'user-a',
      category: 'import_file',
      originalName: 'people.xlsx',
      storagePath: `tenants/x/import-export/${row.id}`,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: 10,
      sha256: 'sha',
      status: 'committed',
      commitFailureCode: null,
      documentExpiresAt: null,
      expiryRemindedAt: null,
      uploadedBy: 'user-a',
      createdAt: NOW,
      deletedAt: null,
      ...row,
    };
    this.files.set(file.id, file);
    return file;
  }

  find(fileId: string) {
    return Promise.resolve(this.files.get(fileId) ?? null);
  }

  openContent() {
    return Promise.resolve(this.content ? Readable.from([this.content]) : null);
  }

  reparent(fileId: string, ref: EntityRef) {
    const file = this.files.get(fileId);
    if (file) this.files.set(fileId, { ...file, ...ref });
    return Promise.resolve();
  }

  softDelete(fileId: string) {
    this.softDeleted.push(fileId);
    return Promise.resolve();
  }

  async storeGenerated(
    command: {
      category: string;
      entityType: string;
      entityId: string;
      fileName: string;
      mime: string;
    },
    write: (sink: Writable) => Promise<void>,
  ): Promise<FileRow> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    await write(sink);
    sink.end();
    const id = nextId();
    this.written.set(id, Buffer.concat(chunks));
    return this.seedFile({ id, ...command, originalName: command.fileName });
  }
}

/** `ConnectionProvider.savepoint` without a database: run it, let it throw. */
export const savepointing = {
  savepoint: <T>(fn: () => Promise<T>) => fn(),
};

const ACTIVE = new Set<ImportJobStatus>([
  'uploaded',
  'validating',
  'awaiting_confirmation',
  'committing',
]);

const TERMINAL = new Set<ImportJobStatus>([
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
]);
