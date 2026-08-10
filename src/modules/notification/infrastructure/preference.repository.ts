import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';

import { ConnectionProvider } from '../../../database/connection.provider';
import { notificationPreferences } from '../../../database/schema';
import { requireTenantContext } from '../../../shared/context';
import type { OptOut, PreferenceRepositoryPort } from '../domain/notification.ports';
import type { NotificationChannel } from '../domain/notification.types';

/**
 * BR-NTF-005's storage: **opt-out rows only**. A user who has never touched
 * their preferences has no rows here, and a user who turns everything back on
 * has none again — which is why the table has no boolean and no default row per
 * template, and why enabling is a `DELETE`.
 *
 * No `TenantScopedRepository`: no §4.2 entry, and a composite primary key with
 * no `id` would not fit the base's helpers anyway.
 */
@Injectable()
export class PreferenceRepository implements PreferenceRepositoryPort {
  constructor(private readonly connection: ConnectionProvider) {}

  private get db() {
    return this.connection.handle();
  }

  listForUser(userId: string): Promise<OptOut[]> {
    return this.db
      .select({
        templateKey: notificationPreferences.templateKey,
        channel: notificationPreferences.channel,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId));
  }

  async optedOutChannels(
    userIds: readonly string[],
    templateKey: string,
  ): Promise<Map<string, Set<NotificationChannel>>> {
    const byUser = new Map<string, Set<NotificationChannel>>();
    if (userIds.length === 0) return byUser;

    const rows = await this.db
      .select({
        userId: notificationPreferences.userId,
        channel: notificationPreferences.channel,
      })
      .from(notificationPreferences)
      .where(
        and(
          inArray(notificationPreferences.userId, [...userIds]),
          eq(notificationPreferences.templateKey, templateKey),
        ),
      );

    for (const row of rows) {
      const channels = byUser.get(row.userId) ?? new Set<NotificationChannel>();
      channels.add(row.channel);
      byUser.set(row.userId, channels);
    }
    return byUser;
  }

  /** Idempotent: toggling a cell already off is a success that writes nothing. */
  async optOut(userId: string, templateKey: string, channel: NotificationChannel): Promise<void> {
    await this.db
      .insert(notificationPreferences)
      .values({ tenantId: requireTenantContext().tenantId, userId, templateKey, channel })
      .onConflictDoNothing();
  }

  async optIn(userId: string, templateKey: string, channel: NotificationChannel): Promise<void> {
    await this.db
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.templateKey, templateKey),
          eq(notificationPreferences.channel, channel),
        ),
      );
  }
}
