import { Inject, Injectable } from '@nestjs/common';

import { requireTenantContext } from '../../../shared/context';
import { ok, type Result } from '../../../shared/result';
import { fieldCodes } from '../../../shared/shared.errors';
import {
  registerImportDefinition,
  type ImportDefinition,
  type ImportRowHandler,
  type ParsedRow,
  type RowError,
} from '../../import-export';
import { shiftRowCodes } from '../domain/shift.errors';
import {
  EMPLOYEE_LOOKUP,
  ROSTER_DAY_REPOSITORY,
  SCHEDULE_CACHE,
  SHIFT_OUTBOX,
  SHIFT_REPOSITORY,
  type EmployeeLookupPort,
  type RosterDayRepositoryPort,
  type ScheduleCachePort,
  type ShiftOutboxPort,
  type ShiftRepositoryPort,
} from '../domain/shift.ports';
import type { ShiftRow } from '../domain/shift.types';
import { WriteGuards } from './write-guards';

export const SHIFT_IMPORT_KEY = 'shift.roster';

/** BR-SHF-012's sentinel: an `OFF` row writes an explicit day off. */
export const OFF_SENTINEL = 'OFF';

/** Statuses a roster row may not be written against — §9's terminal employee. */
const TERMINAL_STATUSES = new Set(['resigned', 'terminated']);

/**
 * UC-SHF-006 — import a monthly roster.
 *
 * BR-SHF-012 is the whole contract and every clause is a field of the definition
 * or a line of `check`: **upsert on `(employee_number, date)`**, `partial`
 * commit, the `OFF` sentinel, and *"each row runs the same validation as a UI
 * write"* — which is why `check` calls the very guards the grid calls rather than
 * a second, import-shaped copy of them.
 *
 * The import **never** creates shifts, patterns or assignments. It writes roster
 * days, and nothing else.
 */
@Injectable()
export class ShiftImportHandler implements ImportRowHandler {
  constructor(
    @Inject(ROSTER_DAY_REPOSITORY) private readonly rosterDays: RosterDayRepositoryPort,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepositoryPort,
    @Inject(EMPLOYEE_LOOKUP) private readonly employees: EmployeeLookupPort,
    @Inject(SCHEDULE_CACHE) private readonly cache: ScheduleCachePort,
    @Inject(SHIFT_OUTBOX) private readonly outbox: ShiftOutboxPort,
    private readonly guards: WriteGuards,
  ) {}

  async check(row: ParsedRow): Promise<readonly RowError[]> {
    const resolved = await this.resolve(row);
    if ('errors' in resolved) return resolved.errors;

    const { employee, shift, date } = resolved;

    const unlocked = await this.guards.requireUnlocked(employee.companyId, [date]);
    if (!unlocked.ok) {
      return [
        {
          column: 'date',
          code: shiftRowCodes.periodLocked,
          params: unlocked.error.details ?? {},
        },
      ];
    }

    const conflict = await this.guards.neighbourConflict(employee.employeeId, date, shift);
    return conflict
      ? [
          {
            column: 'shift_code',
            code: shiftRowCodes.windowOverlap,
            params: { date: conflict.date, conflictingShiftId: conflict.conflictingShiftId },
          },
        ]
      : [];
  }

  async apply(row: ParsedRow): Promise<Result<void>> {
    const resolved = await this.resolve(row);
    // `check` ran in the same pass and put every reason in the report; a row that
    // still fails to resolve here is one whose target moved between the two, and
    // it lands as that row's verdict rather than taking the batch down.
    if ('errors' in resolved) return ok(undefined);

    const { employee, shift, date } = resolved;
    await this.rosterDays.upsert({
      employeeId: employee.employeeId,
      date,
      shiftId: shift?.id ?? null,
      worksOnHoliday: row.values.works_on_holiday === true,
      note: null,
    });

    const tenantId = requireTenantContext().tenantId;
    await this.cache.bustEmployee(tenantId, employee.employeeId);
    await this.outbox.emit({
      name: 'shift.roster.changed',
      tenantId,
      aggregateId: employee.employeeId,
      payload: { employeeIds: [employee.employeeId], dates: [date] },
    });
    return ok(undefined);
  }

  /** The row's three lookups, shared by both passes so they cannot disagree. */
  private async resolve(
    row: ParsedRow,
  ): Promise<
    | { employee: { employeeId: string; companyId: string }; shift: ShiftRow | null; date: string }
    | { errors: RowError[] }
  > {
    const employeeNumber = String(row.values.employee_number ?? '');
    const date = String(row.values.date ?? '');
    const code = String(row.values.shift_code ?? '');

    const employee = await this.employees.findByNumber(employeeNumber);
    if (!employee) {
      return { errors: [{ column: 'employee_number', code: fieldCodes.invalidEnum, params: {} }] };
    }
    if (TERMINAL_STATUSES.has(employee.status)) {
      return {
        errors: [
          {
            column: 'employee_number',
            code: fieldCodes.invalidEnum,
            params: { status: employee.status },
          },
        ],
      };
    }

    if (code.toUpperCase() === OFF_SENTINEL) return { employee, shift: null, date };

    const shift = await this.shifts.findByCode(employee.companyId, code);
    return shift
      ? { employee, shift, date }
      : {
          errors: [
            { column: 'shift_code', code: fieldCodes.invalidEnum, params: { shift_code: code } },
          ],
        };
  }
}

export function shiftImportDefinition(handler: ImportRowHandler): ImportDefinition {
  return {
    key: SHIFT_IMPORT_KEY,
    requiredPermission: 'shift.roster.import',
    templateVersion: 1,
    naturalKey: ['employee_number', 'date'],
    writeMode: 'upsert',
    commitMode: 'partial',
    columns: [
      {
        key: 'employee_number',
        header: { id: 'NIP', en: 'Employee number' },
        type: 'string',
        required: true,
        example: 'EMP-0001',
      },
      {
        key: 'date',
        header: { id: 'Tanggal', en: 'Date' },
        type: 'date',
        required: true,
        example: '2026-09-14',
      },
      {
        key: 'shift_code',
        header: { id: 'Kode shift', en: 'Shift code' },
        type: 'string',
        required: true,
        example: 'OFFICE',
      },
      {
        key: 'works_on_holiday',
        header: { id: 'Kerja saat libur', en: 'Works on holiday' },
        type: 'boolean',
        required: false,
        example: 'false',
      },
    ],
    rowHandler: handler,
  };
}

/** Called once at module init, on `registerFileOwner`'s shape. */
export function registerShiftImport(handler: ImportRowHandler): void {
  registerImportDefinition(shiftImportDefinition(handler));
}
