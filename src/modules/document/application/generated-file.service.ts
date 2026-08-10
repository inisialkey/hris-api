import { createHash } from 'node:crypto';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import { findCategory } from '../domain/categories';
import {
  FILE_REPOSITORY,
  STORAGE_PORT,
  type DocumentPort,
  type FileRepositoryPort,
  type GeneratedFileCommand,
  type StoragePort,
} from '../domain/document.ports';
import type { EntityRef, FileRow } from '../domain/document.types';
import { finalPath, sanitizeFileName } from '../domain/storage-path';

/**
 * UC-DOC-004 — *"workers write objects directly to the final path via the GCS
 * SDK and insert `committed` rows in the same unit of work (no staging — bytes
 * never left the server). `uploadedBy NULL`; category `generated_document` /
 * `import_file`."*
 *
 * Built 2026-08-10 with its first caller (A-200, hris-handbook PR #34). A-197 item 10 recorded that
 * this path was not built and why — no consumer — and import-export is the
 * consumer: an error workbook and an export output are both generated files,
 * and an import source workbook is one this path reads back.
 *
 * **No staged row and no BR-DOC-004 chain**, deliberately. That chain exists to
 * stop believing an uploader; there is no uploader here, and the two facts it
 * establishes — the size and the digest — are measured on the way past instead.
 */
@Injectable()
export class GeneratedFileService implements DocumentPort {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async storeGenerated(
    command: GeneratedFileCommand,
    write: (sink: Writable) => Promise<void>,
  ): Promise<FileRow> {
    const category = findCategory(command.category);
    // An unowned category is not live for a worker either (§4.2). The owner is
    // what answers "may this be read", and a file nobody can ever read is worse
    // than a refused write.
    if (!category) throw new Error(`file category ${command.category} is not live`);
    if (!category.allowedMimes.includes(command.mime)) {
      throw new Error(`mime ${command.mime} is not allowed for category ${command.category}`);
    }

    const fileId = uuidv7();
    const originalName = sanitizeFileName(command.fileName);
    const path = finalPath(
      requireTenantContext().tenantId,
      category.owner.module,
      command.entityId,
      fileId,
      originalName,
    );

    const hash = createHash('sha256');
    let sizeBytes = 0;
    const meter = new PassThrough();
    meter.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      sizeBytes += chunk.length;
    });

    // The generator writes into the meter, the meter feeds the bucket, and the
    // await returns only once GCS has the last byte. Awaiting the producer alone
    // would let the row commit against an object still in flight.
    const upload = pipeline(meter, this.storage.openWrite(path, command.mime));
    await write(meter);
    await upload;

    // `status: 'committed'` at insert — there is no staged phase to leave behind
    // and no window in which the row describes an object nobody verified.
    const created = await this.repository.create({
      module: category.owner.module,
      entityType: command.entityType,
      entityId: command.entityId,
      category: category.key,
      originalName,
      storagePath: path,
      mime: command.mime,
      sizeBytes,
      status: 'committed',
      sha256: hash.digest('hex'),
      // §4.1: `uploaded_by NULL` = worker-generated. The requester is on
      // `created_by`, which the repository stamps from the request context and
      // which BR-IMP-010 reads as the only identity that may download an export.
    });
    return created;
  }

  async find(fileId: string): Promise<FileRow | null> {
    const file = await this.repository.findById(fileId);
    return file && file.status === 'committed' ? file : null;
  }

  async openContent(fileId: string): Promise<Readable | null> {
    const file = await this.find(fileId);
    return file ? this.storage.openRead(file.storagePath) : null;
  }

  async reparent(fileId: string, ref: EntityRef): Promise<void> {
    await this.repository.reparent(fileId, ref);
  }

  async softDelete(fileId: string): Promise<void> {
    // No `clientDeletable` check and no owner predicate: the caller is the
    // module that owns the category, retiring its own artifact. `currentRequest`
    // has no user in a job, which is what leaves `deleted_by` null — the system
    // actor semantics database-conventions §3.1 already defines.
    await this.repository.softDelete(fileId, new Date(), currentRequestContext()?.userId);
  }
}
