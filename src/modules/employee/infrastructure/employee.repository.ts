import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employees } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { blindIndex } from '../../../shared/crypto/encrypted-text';
import { TenantKeyService } from '../../../shared/crypto/tenant-key.service';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { EmployeeFilter, EmployeeRepositoryPort, Page, Paged } from '../domain/employee.ports';
import type {
  EmployeeCreateInput,
  EmployeeListRow,
  EmployeeRow,
  EmployeeStatus,
  EmployeeUpdateInput,
} from '../domain/employee.types';

/**
 * `employees` is core-schema §7's table and this module owns it, so every write
 * to the row is here.
 *
 * **`ensureLoaded()` is the first line of every method that touches the table**,
 * and it is not defensive noise. The ADR-0016 `encryptedText` columns encrypt
 * and decrypt inside Drizzle's synchronous driver hooks, so the tenant's DEK has
 * to be in the process cache *before* the statement runs — on reads as well as
 * writes, because `fromDriver` is what turns a `v1:` string back into a NIK. A
 * missing key throws rather than yielding ciphertext into a domain object.
 *
 * The blind indexes (BR-EMP-004) are written here for the same reason: they are
 * derived from the source field and the HMAC key, and a caller that could forget
 * one would silently break the uniqueness BR-EMP-001 depends on.
 */
@Injectable()
export class EmployeeRepository extends TenantScopedRepository implements EmployeeRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    private readonly keys: TenantKeyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, employees, audit);
  }

  /**
   * The grid. **No `ensureLoaded()` and no encrypted column in the projection**:
   * §4.3 keeps the encrypted set out of the list payload, so selecting it would
   * decrypt twenty NIKs per page to throw them away — the exact cost ADR-0016's
   * tradeoff section promises the list path does not pay. The columns are absent
   * from the query, which is a stronger guarantee than a mapper dropping them.
   */
  async list(filter: EmployeeFilter, page: Page): Promise<Paged<EmployeeListRow>> {
    const where = and(
      isNull(employees.deletedAt),
      filter.companyIds === null
        ? undefined
        : inArray(employees.companyId, orNone(filter.companyIds)),
      filter.companyId ? eq(employees.companyId, filter.companyId) : undefined,
      filter.status ? eq(employees.status, filter.status) : undefined,
      filter.employmentType
        ? eq(employees.employmentType, filter.employmentType as 'pkwt' | 'pkwtt')
        : undefined,
      // §7's `q` searches name and number — never an encrypted column, because
      // there is no partial-match path over one and ADR-0016 says so outright.
      filter.q
        ? or(
            ilike(employees.fullName, `%${filter.q}%`),
            ilike(employees.employeeNumber, `%${filter.q}%`),
          )
        : undefined,
    );

    const rows = await this.db
      .select(LIST_COLUMNS)
      .from(employees)
      .where(where)
      .orderBy(employees.employeeNumber, employees.id)
      .limit(page.limit)
      .offset(page.offset);
    const totals = await this.db.select({ total: count() }).from(employees).where(where);

    return { rows, total: totals[0]?.total ?? 0 };
  }

  async findById(id: string): Promise<EmployeeRow | null> {
    await this.keys.ensureLoaded();
    const rows = await this.db
      .select()
      .from(employees)
      .where(and(eq(employees.id, id), isNull(employees.deletedAt)));
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  async findByUserId(userId: string): Promise<EmployeeRow | null> {
    await this.keys.ensureLoaded();
    const rows = await this.db
      .select()
      .from(employees)
      .where(and(eq(employees.userId, userId), isNull(employees.deletedAt)));
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  findLiveByNikBidx(nikBidx: string, excludeId?: string): Promise<{ id: string } | null> {
    return this.findLiveByBidx(employees.nikBidx, nikBidx, excludeId);
  }

  findLiveByNpwpBidx(npwpBidx: string, excludeId?: string): Promise<{ id: string } | null> {
    return this.findLiveByBidx(employees.npwpBidx, npwpBidx, excludeId);
  }

  async create(input: EmployeeCreateInput, employeeNumber: string): Promise<EmployeeRow> {
    await this.keys.ensureLoaded();
    const indexKey = await this.keys.indexKey();

    const row = await this.insertAudited({
      companyId: input.companyId,
      employeeNumber,
      fullName: input.fullName,
      joinDate: input.joinDate,
      employmentType: input.employmentType,
      status: 'active',
      nik: input.nik,
      nikBidx: blindIndex(indexKey, input.nik),
      npwp: input.npwp ?? null,
      npwpBidx: input.npwp ? blindIndex(indexKey, input.npwp) : null,
      bpjsKesehatanNumber: input.bpjsKesehatanNumber ?? null,
      bpjsKetenagakerjaanNumber: input.bpjsKetenagakerjaanNumber ?? null,
      bankName: input.bankName ?? null,
      bankAccountNumber: input.bankAccountNumber ?? null,
      bankAccountHolder: input.bankAccountHolder ?? null,
      birthPlace: input.birthPlace ?? null,
      birthDate: input.birthDate,
      gender: input.gender,
      maritalStatus: input.maritalStatus,
      religion: input.religion ?? null,
      ptkpStatus: input.ptkpStatus,
      address: input.address ?? null,
      phone: input.phone ?? null,
      personalEmail: input.personalEmail ?? null,
    });
    return toEmployee(row);
  }

  async update(id: string, patch: EmployeeUpdateInput): Promise<EmployeeRow | null> {
    await this.keys.ensureLoaded();
    const values: Record<string, unknown> = { ...patch };

    // A NIK or NPWP edit rewrites its blind index in the same statement. Two
    // statements would leave a window where the index disagrees with the value
    // it indexes, and the uniqueness constraint reads the index.
    if (patch.nik !== undefined) {
      values.nikBidx = blindIndex(await this.keys.indexKey(), patch.nik);
    }
    if (patch.npwp !== undefined) {
      values.npwpBidx = patch.npwp ? blindIndex(await this.keys.indexKey(), patch.npwp) : null;
    }

    const row = await this.updateAudited(id, values);
    return row ? toEmployee(row) : null;
  }

  async linkUser(id: string, userId: string): Promise<void> {
    await this.updateAudited(id, { userId });
  }

  async setStatus(id: string, status: EmployeeStatus): Promise<void> {
    await this.updateAudited(id, { status });
  }

  async setEmploymentType(id: string, kind: 'pkwt' | 'pkwtt'): Promise<void> {
    await this.updateAudited(id, { employmentType: kind });
  }

  async softDelete(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }

  /**
   * BR-EMP-001's predicate, in one place: live **and** non-terminal. The unique
   * index carries the same one, so a check that disagreed with it would either
   * refuse a legal rehire or let the constraint refuse the request instead.
   */
  private async findLiveByBidx(
    column: PgColumn,
    value: string,
    excludeId?: string,
  ): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(column, value),
          isNull(employees.deletedAt),
          inArray(employees.status, ['active', 'on_leave']),
          excludeId ? ne(employees.id, excludeId) : undefined,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

/** `EmployeeListRow`, as a projection. Every column here is plaintext at rest. */
const LIST_COLUMNS = {
  id: employees.id,
  companyId: employees.companyId,
  userId: employees.userId,
  employeeNumber: employees.employeeNumber,
  fullName: employees.fullName,
  joinDate: employees.joinDate,
  employmentType: employees.employmentType,
  status: employees.status,
  birthPlace: employees.birthPlace,
  birthDate: employees.birthDate,
  gender: employees.gender,
  maritalStatus: employees.maritalStatus,
  religion: employees.religion,
  ptkpStatus: employees.ptkpStatus,
  address: employees.address,
  phone: employees.phone,
  personalEmail: employees.personalEmail,
  updatedAt: employees.updatedAt,
} as const;

/** An empty scope must match nothing; `inArray(x, [])` is invalid SQL. */
function orNone(ids: string[]): string[] {
  return ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'];
}

function toEmployee(row: Record<string, unknown>): EmployeeRow {
  const r = row as typeof employees.$inferSelect;
  return {
    id: r.id,
    companyId: r.companyId,
    userId: r.userId,
    employeeNumber: r.employeeNumber,
    fullName: r.fullName,
    joinDate: r.joinDate,
    employmentType: r.employmentType,
    status: r.status,
    nik: r.nik,
    npwp: r.npwp,
    bpjsKesehatanNumber: r.bpjsKesehatanNumber,
    bpjsKetenagakerjaanNumber: r.bpjsKetenagakerjaanNumber,
    bankName: r.bankName,
    bankAccountNumber: r.bankAccountNumber,
    bankAccountHolder: r.bankAccountHolder,
    birthPlace: r.birthPlace,
    birthDate: r.birthDate,
    gender: r.gender,
    maritalStatus: r.maritalStatus,
    religion: r.religion,
    ptkpStatus: r.ptkpStatus,
    address: r.address,
    phone: r.phone,
    personalEmail: r.personalEmail,
    updatedAt: r.updatedAt,
  };
}
