import { Writable } from 'node:stream';

import {
  clearDefinitions,
  registerExportDefinition,
  registerImportDefinition,
  type ImportDefinition,
} from '../domain/definitions';
import type { WorkbookWriterPort } from '../domain/import-export.ports';
import { DefinitionAccessService } from './definition-access.service';
import { DefinitionQueryService } from './definition-query.service';
import { exportDefinition, importDefinition, inScope } from './test-support';

describe('DefinitionQueryService', () => {
  let templated: { definition: ImportDefinition; locale: string }[];
  let service: DefinitionQueryService;

  beforeEach(() => {
    clearDefinitions();
    templated = [];
    const writer: Pick<WorkbookWriterPort, 'template'> = {
      template: (definition, locale) => {
        templated.push({ definition, locale });
        return Promise.resolve();
      },
    };
    service = new DefinitionQueryService(
      writer as WorkbookWriterPort,
      new DefinitionAccessService(),
    );
  });

  describe('GET /definitions — §7’s existence hiding', () => {
    it('is empty when nothing is registered, which is what "not live" means', async () => {
      const catalog = await inScope('user-a', ['employee.master.import'], () => service.catalog());
      expect(catalog).toEqual({ imports: [], exports: [] });
    });

    it('lists only the definitions the caller may actually run', async () => {
      registerImportDefinition(importDefinition());
      registerImportDefinition(
        importDefinition({
          key: 'payroll.salary_opening',
          requiredPermission: 'payroll.salary.import',
        }),
      );
      registerExportDefinition(exportDefinition());

      const catalog = await inScope('user-a', ['employee.master.import'], () => service.catalog());
      expect(catalog.imports.map((row) => row.key)).toEqual(['employee.master']);
      // Holding the import key says nothing about the export of the same name.
      expect(catalog.exports).toEqual([]);
    });

    it('carries the four fields §7 declares for an import, and the params for an export', async () => {
      registerImportDefinition(importDefinition());
      registerExportDefinition(exportDefinition());

      const catalog = await inScope(
        'user-a',
        ['employee.master.import', 'employee.master.export'],
        () => service.catalog(),
      );
      expect(catalog.imports[0]).toEqual({
        key: 'employee.master',
        templateVersion: 1,
        commitMode: 'partial',
        writeMode: 'create_only',
      });
      expect(catalog.exports[0]).toEqual({
        key: 'employee.master',
        params: [{ key: 'companyId', type: 'uuid', required: true }],
      });
    });
  });

  describe('UC-IMP-005 — the template', () => {
    it('resolves the definition before anything is written', async () => {
      registerImportDefinition(importDefinition());
      const found = await inScope('user-a', ['employee.master.import'], () =>
        service.definitionFor('employee.master'),
      );
      expect(found.ok).toBe(true);
      expect(templated).toEqual([]);
    });

    it('refuses a definition the caller may not run, with nothing written', async () => {
      registerImportDefinition(importDefinition());
      const found = await inScope('user-a', [], () => service.definitionFor('employee.master'));
      expect(found.ok).toBe(false);
      if (!found.ok) expect(found.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('writes in the default locale — every V1 render is `id` (A-198, A-200)', async () => {
      registerImportDefinition(importDefinition());
      const found = await inScope('user-a', ['employee.master.import'], () =>
        service.definitionFor('employee.master'),
      );
      if (!found.ok) throw new Error('expected a definition');

      await service.writeTemplate(found.value, new Writable({ write: (_c, _e, done) => done() }));
      expect(templated).toEqual([{ definition: found.value, locale: 'id' }]);
    });
  });
});
