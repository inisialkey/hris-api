import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { fail, ok, type Result } from '../../../shared/result';
import { sharedErrors } from '../../../shared/shared.errors';
import {
  AUTH_OUTBOX,
  DEVICE_REPOSITORY,
  SESSION_REPOSITORY,
  type AuthOutboxPort,
  type DeviceListRow,
  type DeviceRepositoryPort,
  type SessionRepositoryPort,
} from '../domain/auth.ports';
import type { SessionActor } from './session.use-case';

export interface DevicePage {
  rows: DeviceListRow[];
  total: number;
}

/**
 * UC-AUTH-005 and the device list — mirrors the session endpoints
 * (authentication.md §7), with the revoke cascade this module owns: device to
 * `revoked`, its sessions revoked, FCM token dropped, all in the request's one
 * transaction. The revoked device gets no farewell push by design
 * (offline-sync §8's terminal rule).
 */
@Injectable()
export class DeviceUseCase {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepositoryPort,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(AUTH_OUTBOX) private readonly outbox: AuthOutboxPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    actor: SessionActor,
    target: { userId?: string; page: number; pageSize: number },
  ): Promise<Result<DevicePage>> {
    const userId = target.userId ?? actor.userId;
    if (userId !== actor.userId && !(await actor.canActOnOthers())) {
      return fail(sharedErrors.notFound());
    }
    return ok(await this.devices.listForUser(userId, target.page, target.pageSize));
  }

  async revoke(actor: SessionActor, deviceId: string): Promise<Result<{ id: string }>> {
    const device = await this.devices.findById(deviceId);
    if (!device) return fail(sharedErrors.notFound());
    if (device.userId !== actor.userId && !(await actor.canActOnOthers())) {
      return fail(sharedErrors.notFound());
    }

    const now = this.clock.now();
    const revoked = await this.devices.revoke(
      deviceId,
      device.userId === actor.userId ? 'user' : 'admin',
      now,
    );
    // Mirror of the session no-op rule: an already-revoked device is a success.
    if (!revoked) return ok({ id: deviceId });

    const sessionIds = await this.sessions.revokeForDevice(deviceId, now);
    for (const sessionId of sessionIds) {
      await this.outbox.emit({
        name: 'auth.session.revoked',
        tenantId: actor.tenantId,
        aggregateId: sessionId,
        payload: { sessionId, userId: device.userId, reason: 'device_revoked' },
      });
    }
    await this.outbox.emit({
      name: 'auth.device.revoked',
      tenantId: actor.tenantId,
      aggregateId: deviceId,
      payload: { deviceId, userId: device.userId },
    });

    return ok({ id: deviceId });
  }
}
