import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { fail, ok, type Result } from '../../../shared/result';
import { textOf } from '../domain/coercion';
import { importExportErrors } from '../domain/import-export.errors';
import type { ParsedWorkbook, SheetRow, WorkbookReaderPort } from '../domain/import-export.ports';
import { ENUM_SHEET, META_SHEET, TEMPLATE_VERSION_LABEL } from './workbook-layout';

/**
 * **A deviation from ADR-0015's named mechanism, and the reason is a library
 * defect rather than a preference** (A-200, hris-handbook PR #34).
 *
 * The ADR fixes *"exceljs **streaming** both directions (WorkbookReader /
 * streaming writer)"*. The writer half holds and is used. The reader half does
 * not: in exceljs 4.4, `stream.xlsx.WorkbookReader` **emits only the first
 * worksheet of a multi-sheet workbook**, leaves every `name` at its `Sheet<n>`
 * fallback, and — depending on how the source stream chunks — throws
 * `Cannot read properties of undefined (reading 'sheets')` from its own
 * `_parseWorksheet`. Its worksheets are deferred to temp files until
 * `xl/workbook.xml` has been parsed, and that file is written *last* by its own
 * streaming writer, so the deferral races the parse that would name them.
 *
 * BR-IMP-006 puts the template marker in a hidden `_meta` sheet, which makes
 * **every** workbook this module touches a multi-sheet workbook. So the choice
 * was between the rule and the reader, and the rule is the contract.
 *
 * What replaces the ADR's memory bound is not nothing. BR-IMP-007 already
 * imposes two: `.xlsx` only at **20 MB** through document-storage §4.2's
 * category cap, and **10 000 rows** through `import-export.max_rows` — *"three
 * independent bounds, all cheap, all early"*. The file cannot be larger than the
 * category allows before this ever runs, and this refuses past the row cap. What
 * is genuinely lost is the abort *mid-file*: the cap is now checked after the
 * parse rather than during it, which costs the parse of a file that was going to
 * be refused.
 */
@Injectable()
export class XlsxWorkbookReader implements WorkbookReaderPort {
  async read(source: Readable, maxRows: number): Promise<Result<ParsedWorkbook>> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.read(source);
    } catch {
      // §9's *"xlsx that is a valid zip but garbage sheets (or password-
      // protected)"*. Distinct from the DOC-layer mime checks, which this file
      // already passed — the bytes are an xlsx and the workbook inside is not.
      return fail(importExportErrors.fileUnreadable());
    }

    const meta = workbook.worksheets.find((sheet) => sheet.name === META_SHEET);
    const templateVersion = meta ? readTemplateVersion(meta) : null;

    // The first sheet that is neither marker nor enum list is the data sheet,
    // whatever it is called. A user who renamed the tab has not broken their
    // file, and the `_meta` marker is what actually identifies the template.
    const data = workbook.worksheets.find(
      (sheet) => sheet.name !== META_SHEET && sheet.name !== ENUM_SHEET,
    );
    if (!data) return fail(importExportErrors.fileUnreadable());

    let headers: readonly string[] = [];
    const rows: SheetRow[] = [];
    let capExceeded = false;

    data.eachRow({ includeEmpty: false }, (row) => {
      const cells = valuesOf(row.values);
      if (row.number === 1) {
        headers = cells.map(textOf);
        return;
      }
      if (rows.length >= maxRows) {
        capExceeded = true;
        return;
      }
      rows.push({ rowNumber: row.number, cells });
    });

    // BR-IMP-007, *"checked at parse"* — before a single row is coerced or a
    // single lookup is made, which is what the rule is protecting.
    if (capExceeded) return fail(importExportErrors.rowCapExceeded({ maxRows }));

    return ok({ templateVersion, headers, rows });
  }
}

/**
 * `_meta` is two labelled cells rather than a fixed coordinate, so a version
 * bump that adds a row cannot silently shift the one this reads.
 */
function readTemplateVersion(sheet: ExcelJS.Worksheet): number | null {
  let version: number | null = null;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = valuesOf(row.values);
    if (textOf(cells[0]) !== TEMPLATE_VERSION_LABEL) return;
    const raw = cells[1];
    const parsed = typeof raw === 'number' ? raw : Number(textOf(raw));
    if (Number.isSafeInteger(parsed)) version = parsed;
  });
  return version;
}

/**
 * exceljs numbers cells from 1 and leaves index 0 unused, so `row.values` is a
 * sparse array whose first slot is a hole. Normalizing here means every caller
 * indexes from 0 like the rest of the codebase, and a trailing empty cell reads
 * as `null` rather than as `undefined` in one place and absent in another.
 */
function valuesOf(values: unknown): unknown[] {
  if (!Array.isArray(values)) return [];
  return (values as unknown[]).slice(1).map((cell) => cell ?? null);
}
