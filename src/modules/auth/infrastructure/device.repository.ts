import { Injectable } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { devices } from '../../../database/schema';
import type {
  DeviceListRow,
  DeviceRecord,
  DeviceRepositoryPort,
  NewDevice,
} from '../domain/auth.ports';

/** Device registry rows (ADR-0004), under the resolved tenant's context. */
@Injectable()
export class DeviceRepository implements DeviceRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  /**
   * Any status, newest row wins: the partial unique index guards one *active*
   * row per install, and the newest row is the install's current word —
   * a revoked one refuses the login (§7).
   */
  async findByInstallId(installId: string): Promise<DeviceRecord | null> {
    const rows = await this.connection
      .handle()
      .select(RECORD_COLUMNS)
      .from(devices)
      .where(eq(devices.installId, installId))
      .orderBy(sql`${devices.createdAt} desc`)
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(deviceId: string): Promise<DeviceRecord | null> {
    const rows = await this.connection
      .handle()
      .select(RECORD_COLUMNS)
      .from(devices)
      .where(eq(devices.id, deviceId));
    return rows[0] ?? null;
  }

  async countActiveForUser(userId: string): Promise<number> {
    const rows = await this.connection
      .handle()
      .select({ total: count() })
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.status, 'active')));
    return rows[0]?.total ?? 0;
  }

  async create(device: NewDevice, now: Date): Promise<string> {
    const id = uuidv7();
    await this.connection.handle().insert(devices).values({
      id,
      tenantId: device.tenantId,
      userId: device.userId,
      installId: device.installId,
      platform: device.platform,
      model: device.model,
      osVersion: device.osVersion,
      appVersion: device.appVersion,
      fcmToken: device.fcmToken,
      lastSeenAt: now,
      createdBy: device.userId,
      updatedBy: device.userId,
    });
    return id;
  }

  async touch(
    deviceId: string,
    updates: { model: string; osVersion: string; appVersion: string; fcmToken?: string },
    now: Date,
  ): Promise<void> {
    await this.connection
      .handle()
      .update(devices)
      .set({
        model: updates.model,
        osVersion: updates.osVersion,
        appVersion: updates.appVersion,
        // Login always reports the current FCM token (§9); an absent one keeps
        // the stored value rather than erasing a push target.
        ...(updates.fcmToken !== undefined ? { fcmToken: updates.fcmToken } : {}),
        lastSeenAt: now,
      })
      .where(eq(devices.id, deviceId));
  }

  async updateFcmToken(deviceId: string, fcmToken: string, now: Date): Promise<void> {
    await this.connection
      .handle()
      .update(devices)
      .set({ fcmToken, lastSeenAt: now })
      .where(eq(devices.id, deviceId));
  }

  /** UC-AUTH-005: status flip and FCM drop are one statement, no window between. */
  async revoke(
    deviceId: string,
    reason: 'replaced' | 'user' | 'admin',
    now: Date,
  ): Promise<boolean> {
    const revoked = await this.connection
      .handle()
      .update(devices)
      .set({ status: 'revoked', revokedAt: now, revokedReason: reason, fcmToken: null })
      .where(and(eq(devices.id, deviceId), eq(devices.status, 'active')))
      .returning({ id: devices.id });
    return revoked.length > 0;
  }

  async listForUser(
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<{ rows: DeviceListRow[]; total: number }> {
    const db = this.connection.handle();
    const where = eq(devices.userId, userId);

    // Sequential, not `Promise.all`: the transaction rides one `pg` socket
    // (coding-standards-nestjs §4).
    const rows = await db
      .select({
        id: devices.id,
        platform: devices.platform,
        model: devices.model,
        osVersion: devices.osVersion,
        appVersion: devices.appVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
      })
      .from(devices)
      .where(where)
      .orderBy(sql`${devices.createdAt} desc`)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totals = await db.select({ total: count() }).from(devices).where(where);

    return { rows, total: totals[0]?.total ?? 0 };
  }
}

const RECORD_COLUMNS = {
  id: devices.id,
  userId: devices.userId,
  installId: devices.installId,
  platform: devices.platform,
  fcmToken: devices.fcmToken,
  status: devices.status,
};
