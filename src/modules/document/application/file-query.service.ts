import { Inject, Injectable } from '@nestjs/common';

import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { categoriesForEntityType } from '../domain/categories';
import {
  FILE_REPOSITORY,
  type FileRepositoryPort,
  type Page,
  type Paged,
} from '../domain/document.ports';
import type { EntityRef, FileRow } from '../domain/document.types';

/**
 * §7's `GET /documents` — *"`?entityType=&entityId=` (required pair)"*, and the
 * one read in this module that is **advisory rather than enforcing**.
 *
 * The endpoint takes an entity, not a category, so the entity is what resolves:
 * every live category claiming that entity type is asked, and the answer set
 * becomes a `WHERE category IN (…)`. Filtering in SQL rather than after the page
 * boundary is what keeps `meta.total` from counting rows the caller cannot see.
 *
 * Nobody claiming the entity type — and nobody saying yes — are the same 404.
 */
@Injectable()
export class FileQueryService {
  constructor(@Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort) {}

  async listByEntity(ref: EntityRef, page: Page): Promise<Result<Paged<FileRow>>> {
    const claimants = categoriesForEntityType(ref.entityType);
    const readable: string[] = [];

    // Sequential rather than `Promise.all`: this runs inside the request's unit
    // of work, and an owner's answer is a database read on one connection
    // (coding-standards-nestjs §4).
    for (const category of claimants) {
      if (await category.owner.canRead(ref)) readable.push(category.key);
    }

    if (readable.length === 0) return fail(sharedErrors.notFound());
    return ok(await this.repository.listByEntity(ref.entityType, ref.entityId, readable, page));
  }
}
