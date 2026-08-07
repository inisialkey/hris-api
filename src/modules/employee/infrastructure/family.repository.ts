import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeFamilyMembers } from '../../../database/schema';
import { TenantScopedRepository } from '../../../database/tenant-scoped.repository';
import { CLOCK, type Clock } from '../../../shared/clock.port';
import { AUDIT_CHANGE_PORT, type AuditChangePort } from '../../audit';
import type { FamilyRepositoryPort } from '../domain/employee.ports';
import type { FamilyMemberRow } from '../domain/employee.types';

@Injectable()
export class FamilyRepository extends TenantScopedRepository implements FamilyRepositoryPort {
  constructor(
    connection: ConnectionProvider,
    @Inject(AUDIT_CHANGE_PORT) audit: AuditChangePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super(connection, employeeFamilyMembers, audit);
  }

  async listFor(employeeId: string): Promise<FamilyMemberRow[]> {
    const rows = await this.db
      .select()
      .from(employeeFamilyMembers)
      .where(
        and(
          eq(employeeFamilyMembers.employeeId, employeeId),
          isNull(employeeFamilyMembers.deletedAt),
        ),
      )
      .orderBy(employeeFamilyMembers.name);
    return rows.map(toFamilyMember);
  }

  async findById(id: string): Promise<FamilyMemberRow | null> {
    const row = await this.findRowById(id);
    return row ? toFamilyMember(row as typeof employeeFamilyMembers.$inferSelect) : null;
  }

  async create(values: Omit<FamilyMemberRow, 'id'>): Promise<FamilyMemberRow> {
    const row = await this.insertAudited({ ...values });
    return toFamilyMember(row as typeof employeeFamilyMembers.$inferSelect);
  }

  async update(
    id: string,
    patch: Partial<Omit<FamilyMemberRow, 'id' | 'employeeId'>>,
  ): Promise<FamilyMemberRow | null> {
    const row = await this.updateAudited(id, patch);
    return row ? toFamilyMember(row as typeof employeeFamilyMembers.$inferSelect) : null;
  }

  async softDelete(id: string): Promise<boolean> {
    return (await this.softDeleteAudited(id, this.clock.now())) !== null;
  }
}

function toFamilyMember(row: typeof employeeFamilyMembers.$inferSelect): FamilyMemberRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    name: row.name,
    relationship: row.relationship,
    birthDate: row.birthDate,
    phone: row.phone,
    isEmergencyContact: row.isEmergencyContact,
  };
}
