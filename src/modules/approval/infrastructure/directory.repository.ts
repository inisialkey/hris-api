import { Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { employeeDirectory } from '../../../database/schema';
import type { ApprovalDirectoryPort, DirectoryEntry } from '../domain/approval.ports';

/**
 * The engine's read of `employee_directory` — ADR-0001 rule 6's published
 * read-model view, and the third cross-module channel after facades and events.
 *
 * Three questions, all of them about identity rather than about employment:
 * which company scopes this requester's chain, which user is the requester, and
 * what to call the people on a timeline. The view carries all of it and decrypts
 * nothing, which is exactly the shape rule 6 was amended for.
 */
@Injectable()
export class ApprovalDirectoryRepository implements ApprovalDirectoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async byEmployeeId(employeeId: string): Promise<DirectoryEntry | null> {
    const rows = await this.connection
      .handle()
      .select()
      .from(employeeDirectory)
      .where(eq(employeeDirectory.employeeId, employeeId));
    const row = rows[0];
    return row ? toEntry(row) : null;
  }

  async byUserIds(userIds: readonly string[]): Promise<Map<string, DirectoryEntry>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.connection
      .handle()
      .select()
      .from(employeeDirectory)
      .where(inArray(employeeDirectory.userId, [...userIds]));
    return new Map(rows.filter((row) => row.userId).map((row) => [row.userId!, toEntry(row)]));
  }

  async employeeIdOf(userId: string): Promise<string | null> {
    const rows = await this.connection
      .handle()
      .select({ employeeId: employeeDirectory.employeeId })
      .from(employeeDirectory)
      .where(eq(employeeDirectory.userId, userId));
    return rows[0]?.employeeId ?? null;
  }
}

type DirectoryRecord = {
  employeeId: string;
  userId: string | null;
  companyId: string;
  fullName: string;
};

function toEntry(row: DirectoryRecord): DirectoryEntry {
  return {
    employeeId: row.employeeId,
    userId: row.userId,
    companyId: row.companyId,
    fullName: row.fullName,
  };
}
