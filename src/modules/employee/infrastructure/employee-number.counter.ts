import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { counters } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { EmployeeNumberCounterPort } from '../domain/employee.ports';

const COUNTER_KEY = 'employee_number';

/**
 * database-conventions §6 — the per-company counter, incremented inside the
 * creating transaction.
 *
 * `MAX(employee_number) + 1` is what everyone reaches for and is wrong twice:
 * it races two concurrent hires onto the same number, and it collides with a
 * number an admin typed by hand (BR-EMP-012 honours a provided one). A global
 * sequence is wrong differently — gaps leak how many employees every *other*
 * tenant created.
 *
 * `ON CONFLICT … DO UPDATE` is the row lock: the first hire in a company mints
 * the counter row and increments it in one statement, so there is no read-then-
 * write window for a second hire to slip into. The `RETURNING` value is the
 * number this transaction owns, and it is released only by the transaction
 * rolling back — which is BR-EMP-002's atomicity in the one place where the
 * failure would otherwise be invisible.
 */
@Injectable()
export class EmployeeNumberCounter implements EmployeeNumberCounterPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async next(companyId: string): Promise<string> {
    const tenantId = requireTenantContext().tenantId;
    const db = this.connection.handle();

    const rows = await db
      .insert(counters)
      .values({
        id: uuidv7(),
        tenantId,
        companyId,
        key: COUNTER_KEY,
        currentValue: 1,
      })
      .onConflictDoUpdate({
        target: [counters.tenantId, counters.companyId, counters.key],
        set: { currentValue: sql`${counters.currentValue} + 1` },
      })
      .returning({ value: counters.currentValue });

    const value = rows[0]?.value;
    if (value === undefined) {
      // `ON CONFLICT` matched nothing and inserted nothing, which under this
      // target can only mean the unique index is missing.
      throw new Error('employee_number counter returned no row');
    }

    // Format is a module decision (conventions §6). Zero-padded to five so a
    // grid sorts lexicographically the way a human expects, and wide enough for
    // D1's 10,000-employee ceiling with room left.
    return `EMP-${String(value).padStart(5, '0')}`;
  }
}
