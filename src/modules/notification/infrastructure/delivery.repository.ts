import { Injectable } from '@nestjs/common';
import { and, count, eq, gte } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../../database/connection.provider';
import { notificationDeliveries, notifications } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { DeliveryRepositoryPort, NewDelivery } from '../domain/notification.ports';
import type { DeliveryStatus, NotificationChannel } from '../domain/notification.types';

/** Not on `TenantScopedRepository`, for `notifications`' reason — no §4.2 entry. */
@Injectable()
export class DeliveryRepository implements DeliveryRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  /**
   * One statement per notification, not per channel: the rows are created
   * together, in the same transaction as the notification they belong to, and a
   * partial set would be a feed row whose channels nobody can account for.
   */
  async createMany(deliveries: readonly NewDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;

    const tenantId = requireTenantContext().tenantId;
    await this.db.insert(notificationDeliveries).values(
      deliveries.map((delivery) => ({
        id: uuidv7(),
        tenantId,
        notificationId: delivery.notificationId,
        channel: delivery.channel,
        status: delivery.status,
        sentAt: delivery.sentAt,
      })),
    );
  }

  async listFor(
    notificationId: string,
  ): Promise<{ channel: NotificationChannel; status: DeliveryStatus }[]> {
    return this.db
      .select({
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
      })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, notificationId));
  }

  /**
   * §13's one number. `idx_notification_deliveries_status` leads with
   * `tenant_id` and carries `status`, so the tenant's failed set is a range scan
   * even when its sent rows are not.
   *
   * The time bound reads `notifications.created_at`, because a delivery row
   * carries no creation stamp of its own — §4.1 gives it only `sent_at`, which
   * a failed row never has.
   */
  async countFailedSince(from: Date): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(and(eq(notificationDeliveries.status, 'failed'), gte(notifications.createdAt, from)));
    return rows[0]?.value ?? 0;
  }
}
