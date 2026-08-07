import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';

import type { AppError } from '../../../shared/app-error';
import { currentRequestContext, requireTenantContext } from '../../../shared/context';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { documentErrors } from '../domain/document.errors';
import {
  DOCUMENT_OUTBOX,
  FILE_REPOSITORY,
  STORAGE_PORT,
  type DocumentOutboxPort,
  type FileRepositoryPort,
  type StoragePort,
} from '../domain/document.ports';
import type { FileRow, UploadSlot } from '../domain/document.types';
import { HEAD_BYTES, sniff, sniffedLabel } from '../domain/mime';
import { finalPath, sanitizeFileName, stagingPath } from '../domain/storage-path';
import { FileAccessService } from './access.service';

/** UC-DOC-001: *"signed PUT (exact mime, size range) valid 15 min"*. */
const SLOT_TTL_SECONDS = 15 * 60;

export interface SlotCommand {
  category: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

/**
 * UC-DOC-001 and UC-DOC-002 — the two halves of one act, which is why they share
 * a file: a slot with no confirm is a staged row the sweep collects, and a
 * confirm with no slot has nothing to verify.
 */
@Injectable()
export class UploadUseCase {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(DOCUMENT_OUTBOX) private readonly outbox: DocumentOutboxPort,
    private readonly access: FileAccessService,
  ) {}

  /**
   * UC-DOC-001. §5 narrates the checks the other way round — *"Registry check
   * (category live, mime whitelisted, size ≤ effective cap) → write gate +
   * ownership resolver"* — and the gate runs first here on purpose: for a caller
   * the owner permits, both orders give the same answer, and for one it does not,
   * this order says 404 where the other would have handed back the category's
   * mime whitelist and its cap first. §5 is behaviour, not contract (§4's
   * authority table), and the safer order describes the same behaviour.
   */
  async requestSlot(command: SlotCommand): Promise<Result<UploadSlot>> {
    const gate = await this.access.forWrite(command.category, command);
    if (!gate.ok) return gate;
    const category = gate.value;

    const cap = await this.access.effectiveCap(category);
    if (cap === null) {
      // §4.2's "— (worker-only)". UC-DOC-004 writes those straight to the final
      // path and no client slot exists; 404 rather than a new code, because the
      // absence of an upload path is the absence of the resource.
      return fail(sharedErrors.notFound());
    }
    if (!category.allowedMimes.includes(command.mime)) {
      return fail(documentErrors.typeNotAllowed({ allowed: category.allowedMimes }));
    }
    if (command.sizeBytes > cap) {
      return fail(documentErrors.sizeExceeded({ maxBytes: cap }));
    }

    const fileId = uuidv7();
    const tenantId = requireTenantContext().tenantId;
    const originalName = sanitizeFileName(command.fileName);
    const path = stagingPath(
      tenantId,
      category.owner.module,
      command.entityId,
      fileId,
      originalName,
    );

    // The row is written before the URL is signed. A staged row with no upload
    // is what the sweep exists for; a signed PUT with no row would be bytes the
    // application has no record of, which BR-DOC-001 says do not exist.
    const created = await this.repository.create({
      module: category.owner.module,
      entityType: command.entityType,
      entityId: command.entityId,
      category: category.key,
      originalName,
      storagePath: path,
      mime: command.mime,
      sizeBytes: command.sizeBytes,
      status: 'staged',
      uploadedBy: currentRequestContext()?.userId,
    });

    const signed = await this.storage.signUpload(created.storagePath, {
      mime: command.mime,
      maxBytes: cap,
      ttlSeconds: SLOT_TTL_SECONDS,
    });
    return ok({ fileId: created.id, uploadUrl: signed.url, uploadExpiresAt: signed.expiresAt });
  }

  /**
   * UC-DOC-002 — BR-DOC-004's chain, in its stated order: *"object exists → size
   * within category cap and matches the declared size → magic-byte mime matches
   * declared mime and category whitelist → sha256 computed and stored → move to
   * final path → row committed"*.
   *
   * Every failure leaves the row **staged** with the code recorded, so the
   * client may retry the same slot. That is not politeness: the signed PUT is
   * still valid, and forcing a new slot would orphan the bytes already uploaded.
   */
  async confirm(fileId: string): Promise<Result<FileRow>> {
    const file = await this.repository.findById(fileId);
    if (!file) return fail(sharedErrors.notFound());

    const gate = await this.access.forWrite(file.category, file);
    if (!gate.ok) return gate;

    // BR-DOC-006 — *"confirming a `committed` file returns 200 with the existing
    // metadata"*. Before any storage call, because an offline drain replaying
    // three times should cost three row reads and nothing else.
    if (file.status === 'committed') return ok(file);

    const cap = await this.access.effectiveCap(gate.value);
    const object = await this.storage.inspect(file.storagePath, HEAD_BYTES);
    if (!object || object.sizeBytes === 0) {
      return this.reject(file.id, documentErrors.uploadIncomplete());
    }

    if (cap !== null && object.sizeBytes > cap) {
      return this.reject(file.id, documentErrors.sizeExceeded({ maxBytes: cap }));
    }
    // §7: `DOC_SIZE_EXCEEDED` is *"actual object over cap/**declared**"*. Under
    // the declared size is not a failure — BR-DOC-010 has the client compress a
    // selfie before it uploads, so promising a bound and delivering less is the
    // normal case. Either way the row stores the verified bytes, never the
    // claim (A-197).
    if (object.sizeBytes > file.sizeBytes) {
      return this.reject(file.id, documentErrors.sizeExceeded({ maxBytes: file.sizeBytes }));
    }

    if (!sniff(object.head).includes(file.mime)) {
      return this.reject(
        file.id,
        documentErrors.mimeMismatch({ declared: file.mime, sniffed: sniffedLabel(object.head) }),
      );
    }

    const destination = finalPath(
      requireTenantContext().tenantId,
      file.module,
      file.entityId,
      file.id,
      file.originalName,
    );
    try {
      await this.storage.move(file.storagePath, destination);
    } catch (error) {
      // §9's two-device race, and this is where it actually lands: both confirms
      // read a `staged` row, both call `move`, and the loser's source object is
      // already gone. *"First commits; second hits BR-DOC-006 idempotent
      // success"* — so a move failure is only a failure if the row is still
      // staged, and the row is what decides.
      const winner = await this.repository.findById(file.id);
      if (winner?.status === 'committed') return ok(winner);
      throw error;
    }

    const committed = await this.repository.commit(file.id, {
      storagePath: destination,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
    });
    // Losing the update means the same race decided one statement later.
    if (!committed) return ok((await this.repository.findById(file.id)) ?? file);

    await this.outbox.emit({
      name: 'document.file.committed',
      tenantId: requireTenantContext().tenantId,
      aggregateId: committed.id,
      payload: {
        fileId: committed.id,
        category: committed.category,
        entityType: committed.entityType,
        entityId: committed.entityId,
      },
    });
    return ok(committed);
  }

  private async reject(fileId: string, error: AppError): Promise<Result<never>> {
    await this.repository.recordCommitFailure(fileId, error.code);
    return fail(error);
  }
}
