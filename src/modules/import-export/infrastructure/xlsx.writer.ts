import type { Writable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import type { ImportDefinition } from '../domain/definitions';
import type {
  ErrorReportInput,
  ExportWriteInput,
  WorkbookWriterPort,
} from '../domain/import-export.ports';
import type { Locale } from '../domain/import-export.types';
import { guardValue } from '../domain/injection';
import { messageFor } from '../domain/row-messages';
import {
  DATA_SHEET,
  DEFINITION_KEY_LABEL,
  ENUM_SHEET,
  META_SHEET,
  TEMPLATE_VERSION_LABEL,
} from './workbook-layout';

/**
 * ADR-0015's streaming writer, for all three artifacts this module produces.
 *
 * `WorkbookWriter` flushes each committed row and never holds the sheet, which
 * is what makes a ten-thousand-row export a bounded cost rather than a heap the
 * size of the file. The cost of that is discipline the buffered API does not
 * ask for: a row is not written until `commit()`, a sheet is not closed until
 * its own `commit()`, and forgetting either produces a valid-looking workbook
 * with nothing in it.
 */
@Injectable()
export class XlsxWorkbookWriter implements WorkbookWriterPort {
  /**
   * UC-IMP-005 — *"localized headers (requester's locale), one example row,
   * hidden enum sheet + `_meta` version"*, and BR-IMP-012's one sanctioned
   * synchronous file response.
   *
   * `_meta` is created **first** so that it is also the first sheet the reader
   * meets. That ordering is what makes BR-IMP-006's *"fails immediately … one
   * specific error instead of fifty mysterious row failures"* literally true
   * rather than merely eventual.
   */
  async template(definition: ImportDefinition, locale: Locale, sink: Writable): Promise<void> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: false });

    const meta = workbook.addWorksheet(META_SHEET, { state: 'hidden' });
    meta.addRow([TEMPLATE_VERSION_LABEL, definition.templateVersion]).commit();
    meta.addRow([DEFINITION_KEY_LABEL, definition.key]).commit();
    meta.commit();

    const data = workbook.addWorksheet(DATA_SHEET);
    data.addRow(definition.columns.map((column) => column.header[locale])).commit();
    // Exactly one example row. Its cells are illustrative strings and are
    // injection-guarded like any other written cell — a definition author is
    // trusted, and a rule with an exception is a rule somebody will find.
    data.addRow(definition.columns.map((column) => guardValue(column.example ?? ''))).commit();
    data.commit();

    const enums = definition.columns.filter((column) => column.type === 'enum');
    if (enums.length > 0) {
      const sheet = workbook.addWorksheet(ENUM_SHEET, { state: 'hidden' });
      sheet.addRow(enums.map((column) => column.header[locale])).commit();
      // Column-per-enum, value-per-row: the shape a spreadsheet data-validation
      // range wants, so a later template can point at it without a re-layout.
      const depth = Math.max(...enums.map((column) => column.enumValues?.length ?? 0));
      for (let index = 0; index < depth; index += 1) {
        sheet.addRow(enums.map((column) => column.enumValues?.[index] ?? '')).commit();
      }
      sheet.commit();
    }

    await workbook.commit();
  }

  /**
   * BR-IMP-009 — *"Error reports mirror the input file: original row numbers,
   * per-row error codes + localized messages."*
   *
   * Errored rows only. "Mirror" is about the layout and the numbering, not about
   * reproducing nine thousand rows that were fine: what the reader has to do is
   * find row 4,127 in their own file, and a report where every line is something
   * to fix is what makes that possible.
   */
  async errorReport(input: ErrorReportInput, sink: Writable): Promise<void> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: false });
    const sheet = workbook.addWorksheet(DATA_SHEET);

    const rowLabel = input.locale === 'id' ? 'Baris' : 'Row';
    const codeLabel = input.locale === 'id' ? 'Kode' : 'Code';
    const messageLabel = input.locale === 'id' ? 'Keterangan' : 'Message';
    sheet.addRow([rowLabel, ...input.headers, codeLabel, messageLabel]).commit();

    const byRow = new Map(input.verdicts.map((verdict) => [verdict.rowNumber, verdict.errors]));
    for (const row of input.rows) {
      const errors = byRow.get(row.rowNumber);
      if (!errors || errors.length === 0) continue;
      sheet
        .addRow([
          row.rowNumber,
          ...row.cells.map((cell) => guardValue(toCell(cell))),
          // One row, every reason. Splitting a row across lines would break the
          // "find row 4,127" property the row number exists for.
          errors.map((error) => error.code).join(', '),
          errors
            .map(
              (error) =>
                `${labelOf(error.column, input.definition, input.locale)}${messageFor(error, input.locale)}`,
            )
            .join('; '),
        ])
        .commit();
    }

    sheet.commit();
    await workbook.commit();
  }

  /**
   * UC-IMP-006's writer half: *"streaming query port → streaming writer
   * (injection defense per cell, BR-IMP-010; permission-gated column sets
   * resolved from the requester's effective permissions at enqueue)"*.
   *
   * The columns arrive already frozen — this writes what it is given and makes
   * no entitlement decision, which is what keeps §9's revoked-permission case
   * answerable: the file matches what the requester could see when they asked.
   */
  async exportRows(input: ExportWriteInput, sink: Writable): Promise<number> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: false });
    const sheet = workbook.addWorksheet(DATA_SHEET);
    sheet.addRow(input.columns.map((column) => column.header[input.locale])).commit();

    let rowCount = 0;
    for await (const row of input.stream) {
      sheet.addRow(input.columns.map((column) => guardValue(row[column.key] ?? null))).commit();
      rowCount += 1;
    }

    sheet.commit();
    await workbook.commit();
    return rowCount;
  }
}

/** A raw input cell put back on a page: whatever it was, as text a human reads. */
function toCell(cell: unknown): string | number | boolean | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean')
    return cell;
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  const object = cell as Record<string, unknown>;
  if ('result' in object) return toCell(object.result);
  if ('text' in object) return toCell(object.text);
  return null;
}

/** `nik: ` — the column's own localized header, so the message points somewhere. */
function labelOf(column: string | null, definition: ImportDefinition, locale: Locale): string {
  if (!column) return '';
  const declared = definition.columns.find((candidate) => candidate.key === column);
  return `${declared ? declared.header[locale] : column}: `;
}
