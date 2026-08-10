import { Inject, Injectable } from '@nestjs/common';

import {
  DELIVERY_REPOSITORY,
  type DeliveryRepositoryPort,
  type NotificationStatsPort,
} from '../domain/notification.ports';

/**
 * §13's served port, for system-administration.md UC-ADM-010.
 *
 * A pass-through, and it stays one: the port promises *"no channel breakdown, no
 * message content, no recipients"*, so there is nothing to compute and the value
 * of the class is that the platform-health page reaches a number without
 * reaching this module's tables.
 */
@Injectable()
export class NotificationStatsService implements NotificationStatsPort {
  constructor(@Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepositoryPort) {}

  failedDeliveryCount(from: Date): Promise<number> {
    return this.deliveries.countFailedSince(from);
  }
}
