import { Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { auditAnchors } from '../../../database/schema';
import type { AnchorRecord, AuditAnchorRepositoryPort } from '../domain/audit.ports';

/** BR-AUD-009's per-tenant daily digest. Append-only for the same reason the log is. */
@Injectable()
export class AuditAnchorRepository implements AuditAnchorRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  async findByDay(day: string): Promise<AnchorRecord | null> {
    const rows = await this.connection
      .handle()
      .select()
      .from(auditAnchors)
      .where(eq(auditAnchors.day, day));
    const row = rows[0];
    return row
      ? { day: row.day, rowCount: row.rowCount, digest: row.digest, prevDigest: row.prevDigest }
      : null;
  }

  /**
   * The newest anchor strictly before `day` — not "yesterday's". A skipped day
   * back-filled later chains onto whatever actually preceded it, which is what
   * keeps the chain continuous across the gap (§9, UC-AUD-005).
   */
  async findPreviousDigest(day: string): Promise<string | null> {
    const rows = await this.connection
      .handle()
      .select({ digest: auditAnchors.digest })
      .from(auditAnchors)
      .where(lt(auditAnchors.day, day))
      .orderBy(desc(auditAnchors.day))
      .limit(1);
    return rows[0]?.digest ?? null;
  }

  async insert(tenantId: string, anchor: AnchorRecord): Promise<void> {
    await this.connection.handle().insert(auditAnchors).values({
      id: uuidv7(),
      tenantId,
      day: anchor.day,
      rowCount: anchor.rowCount,
      digest: anchor.digest,
      prevDigest: anchor.prevDigest,
    });
  }
}
