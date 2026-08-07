import { Inject, Injectable } from '@nestjs/common';

import {
  FILE_REPOSITORY,
  type FileRepositoryPort,
  type StorageUsagePort,
} from '../domain/document.ports';
import type { CategoryUsage } from '../domain/document.types';

/**
 * §13's `StorageUsagePort`, added for system-administration UC-ADM-010.
 *
 * A pass-through, and deliberately: the port's narrowness *is* the design — no
 * tenant argument, no filters, no pagination, counts and bytes only. Putting
 * logic here would be putting it somewhere the port's shape no longer guards.
 */
@Injectable()
export class StorageUsageService implements StorageUsagePort {
  constructor(@Inject(FILE_REPOSITORY) private readonly repository: FileRepositoryPort) {}

  usageByCategory(): Promise<CategoryUsage[]> {
    return this.repository.usageByCategory();
  }
}
