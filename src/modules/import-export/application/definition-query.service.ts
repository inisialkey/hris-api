import type { Writable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import type { Result } from '../../../shared/result';
import {
  listExportDefinitions,
  listImportDefinitions,
  type ImportDefinition,
  type ParamSpec,
} from '../domain/definitions';
import { WORKBOOK_WRITER, type WorkbookWriterPort } from '../domain/import-export.ports';
import { DEFAULT_LOCALE } from '../domain/locale';
import { DefinitionAccessService } from './definition-access.service';

export interface ImportDefinitionSummary {
  key: string;
  templateVersion: number;
  commitMode: 'partial' | 'strict';
  writeMode: 'create_only' | 'upsert' | 'update_only';
}

export interface ExportDefinitionSummary {
  key: string;
  params: readonly ParamSpec[];
}

export interface DefinitionCatalog {
  imports: ImportDefinitionSummary[];
  exports: ExportDefinitionSummary[];
}

/**
 * `GET /definitions` and UC-IMP-005's template download.
 *
 * §7: *"filtered to the caller's permissions (existence hiding applies to
 * definitions the caller can't run)"*. Which makes the catalog a per-caller
 * answer rather than a static one — two admins of the same tenant see different
 * lists, and that is the point: a payroll admin should not learn that a
 * `payroll.salary_opening` import exists by reading a list they cannot act on.
 */
@Injectable()
export class DefinitionQueryService {
  constructor(
    @Inject(WORKBOOK_WRITER) private readonly writer: WorkbookWriterPort,
    private readonly access: DefinitionAccessService,
  ) {}

  async catalog(): Promise<DefinitionCatalog> {
    const held = await this.access.heldPermissions();
    return {
      imports: listImportDefinitions()
        .filter((definition) => held.has(definition.requiredPermission))
        .map((definition) => ({
          key: definition.key,
          templateVersion: definition.templateVersion,
          commitMode: definition.commitMode,
          writeMode: definition.writeMode,
        })),
      exports: listExportDefinitions()
        .filter((definition) => held.has(definition.requiredPermission))
        .map((definition) => ({ key: definition.key, params: definition.params })),
    };
  }

  /**
   * UC-IMP-005's gate, separated from its write on purpose.
   *
   * A streamed response commits its status and headers the moment the first byte
   * goes out, so the refusal has to be decidable **before** anything is written —
   * otherwise a caller without the permission gets a 200 with half a workbook
   * and a stack trace in the middle of it.
   */
  async definitionFor(type: string): Promise<Result<ImportDefinition>> {
    return this.access.importFor(type);
  }

  /**
   * UC-IMP-005 — *"generate from the live definition … synchronous streamed
   * response (BR-IMP-012)"*, the module's one sanctioned synchronous file.
   *
   * Generated per request and never stored, which is what keeps it honest: a
   * cached template is a template that outlives the version bump it was written
   * against, and the resulting file would fail BR-IMP-006 on upload with the
   * error that is supposed to mean *"you used an old template"*.
   */
  async writeTemplate(definition: ImportDefinition, sink: Writable): Promise<void> {
    await this.writer.template(definition, DEFAULT_LOCALE, sink);
  }
}
