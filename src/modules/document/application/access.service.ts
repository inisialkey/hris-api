import { Inject, Injectable } from '@nestjs/common';

import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import { SETTINGS_PORT, type SettingsPort } from '../../settings';
import { findCategory, type Category } from '../domain/categories';
import type { EntityRef, FileRow } from '../domain/document.types';

const MB = 1024 * 1024;

/**
 * §2's gate, in one place because every endpoint in this module runs it.
 *
 * The module has **no permission keys of its own** and its routes are
 * `@AuthenticatedOnly()` — a documented deviation from static
 * `@RequirePermission`, sanctioned by §2 and accepted by the route lint. What
 * replaces the decorator is this: the category registry names the owner, the
 * owner answers, and *every* refusal is 404.
 *
 * 404 rather than 403 throughout, including for a caller who plainly holds the
 * permission and simply has the wrong company: telling a company-scoped admin
 * that a file exists on an employee they may not see is the disclosure the scope
 * was drawn to prevent (§2, api-standards §11).
 */
@Injectable()
export class FileAccessService {
  constructor(@Inject(SETTINGS_PORT) private readonly settings: SettingsPort) {}

  /** The write gate for both halves of the upload — slot and confirm. */
  async forWrite(categoryKey: string, ref: EntityRef): Promise<Result<Category>> {
    return this.gate(categoryKey, ref, (category) => category.owner.canWrite(ref));
  }

  async forRead(file: FileRow): Promise<Result<Category>> {
    return this.gate(file.category, file, (category) => category.owner.canRead(file));
  }

  async forDelete(file: FileRow): Promise<Result<Category>> {
    return this.gate(file.category, file, (category) => category.owner.canDelete(file));
  }

  /**
   * BR-DOC-007: the registry ceiling and the tenant setting, *"caps tighten only
   * downward"*. `Math.min` is the whole of the direction rule — a tenant that
   * sets 50 MB on a 10 MB category gets 10, silently and correctly, because
   * BR-SET-008 already refused the write at the editor.
   */
  async effectiveCap(category: Category): Promise<number | null> {
    if (category.maxSizeBytes === null) return null;
    if (!category.sizeSettingKey) return category.maxSizeBytes;

    // Tenant scope, because both size keys are registered `allowedLevels:
    // ['tenant']`. A company-scoped cap would need the file's company, and
    // `files` carries none — the owning entity does. If a key ever opens to
    // `company`, the owner grows a `companyOf(ref)` and this call takes a scope.
    const configured = await this.settings.resolve<number>(category.sizeSettingKey);
    return Math.min(category.maxSizeBytes, configured * MB);
  }

  private async gate(
    categoryKey: string,
    ref: EntityRef,
    permitted: (category: Category) => Promise<boolean>,
  ): Promise<Result<Category>> {
    const category = findCategory(categoryKey);
    // Unknown key, or a key whose owning module has not registered: both are
    // "not live", and neither is a fact a client needs distinguished.
    if (!category) return fail(sharedErrors.notFound());
    if (!category.owner.entityTypes.includes(ref.entityType)) return fail(sharedErrors.notFound());
    return (await permitted(category)) ? ok(category) : fail(sharedErrors.notFound());
  }
}
