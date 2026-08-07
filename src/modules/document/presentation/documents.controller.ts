import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly } from '../../authz';
import { DeleteFileUseCase } from '../application/delete.use-case';
import { DownloadUseCase } from '../application/download.use-case';
import { FileQueryService } from '../application/file-query.service';
import { UploadUseCase } from '../application/upload.use-case';
import type { FileRow } from '../domain/document.types';
import { CreateUploadSlotDto, ListDocumentsQueryDto } from './dto/document.dto';

/**
 * §7's five endpoints, and every one of them `@AuthenticatedOnly()`.
 *
 * That is §2's **documented deviation**, not an oversight: file authorization is
 * delegated to the owning category, so there is no static key this controller
 * could declare — `employee_document` needs `employee.document.*` and `receipt`
 * needs *"self, or `expense.claim.create`"*, and the route serves both. The
 * registry-driven check runs inside the use case, BR-AUTHZ-002 is satisfied by
 * the explicit marker plus §2's paragraph, and the route lint accepts it.
 */
@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly uploads: UploadUseCase,
    private readonly downloads: DownloadUseCase,
    private readonly query: FileQueryService,
    private readonly deletes: DeleteFileUseCase,
  ) {}

  @Post('uploads')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'requestUploadSlot', summary: 'UC-DOC-001' })
  async requestSlot(@Body() dto: CreateUploadSlotDto) {
    const slot = unwrap(await this.uploads.requestSlot(dto));
    return {
      fileId: slot.fileId,
      uploadUrl: slot.uploadUrl,
      uploadExpiresAt: slot.uploadExpiresAt.toISOString(),
    };
  }

  @Post('uploads/:fileId/confirm')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'confirmUpload', summary: 'UC-DOC-002' })
  async confirm(@Param('fileId', ParseUUIDPipe) fileId: string) {
    return toMetadata(unwrap(await this.uploads.confirm(fileId)));
  }

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'listDocuments', summary: 'Files attached to one entity' })
  async list(@Query() query: ListDocumentsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const found = unwrap(
      await this.query.listByEntity(
        { entityType: query.entityType, entityId: query.entityId },
        { limit: pageSize, offset: (page - 1) * pageSize },
      ),
    );
    return {
      data: found.rows.map(toMetadata),
      meta: {
        page,
        pageSize,
        totalItems: found.total,
        totalPages: Math.ceil(found.total / pageSize),
      },
    };
  }

  @Get(':fileId/download-url')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'mintDownloadUrl', summary: 'UC-DOC-003' })
  async downloadUrl(@Param('fileId', ParseUUIDPipe) fileId: string) {
    const signed = unwrap(await this.downloads.mint(fileId));
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }

  @Delete(':fileId')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'deleteDocument', summary: 'UC-DOC-005' })
  async remove(@Param('fileId', ParseUUIDPipe) fileId: string) {
    return unwrap(await this.deletes.remove(fileId));
  }
}

/**
 * §7's metadata shape. **No `storagePath`, ever** — BR-DOC-011 puts it in the
 * security-standards §10 redaction registry beside `originalName`, and a path
 * that never leaves the server is a path no client can try to guess from.
 */
function toMetadata(file: FileRow) {
  return {
    id: file.id,
    category: file.category,
    originalName: file.originalName,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    documentExpiresAt: file.documentExpiresAt,
    uploadedBy: file.uploadedBy,
    createdAt: file.createdAt.toISOString(),
  };
}
