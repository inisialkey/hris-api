import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory } from '../../../database/schema';
import type { DirectoryReaderPort } from '../domain/employee.ports';
import type { DirectoryRow } from '../domain/employee.types';

/**
 * This module reading its own published view.
 *
 * It is not a redundant path around `EmployeeRepository`: the view carries no
 * encrypted column, so a read through it needs no DEK loaded and decrypts
 * nothing. `/me/team` renders four fields for a manager's direct reports and has
 * no business unwrapping a key to do it — which is the same argument every other
 * consumer of this view makes, applied to the module that publishes it.
 */
@Injectable()
export class DirectoryRepository implements DirectoryReaderPort {
  constructor(private readonly connection: ConnectionProvider) {}

  byEmployeeIds(ids: string[]): Promise<DirectoryRow[]> {
    return this.query(ids, employeeDirectory.employeeId);
  }

  /** `directManagers` answers in user ids; a name needs the employee behind one. */
  byUserIds(userIds: string[]): Promise<DirectoryRow[]> {
    return this.query(userIds, employeeDirectory.userId);
  }

  private async query(values: string[], column: PgColumn): Promise<DirectoryRow[]> {
    if (values.length === 0) return [];

    const rows = await this.connection
      .handle()
      .select()
      .from(employeeDirectory)
      .where(inArray(column, values));

    return rows.map((row) => ({
      employeeId: row.employeeId,
      companyId: row.companyId,
      userId: row.userId,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
      status: row.status,
      joinDate: row.joinDate,
    }));
  }
}
