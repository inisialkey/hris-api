import type { SettingsPort } from '../../settings';
import type { NotificationRepositoryPort } from '../domain/notification.ports';
import { NotificationJobsService } from './notification-jobs.service';

const NOW = new Date('2026-03-10T02:00:00Z');

describe('NotificationJobsService (BR-NTF-010)', () => {
  let cutoffs: Date[];
  let limits: number[];
  let retentionDays: number;
  let jobs: NotificationJobsService;

  beforeEach(() => {
    cutoffs = [];
    limits = [];
    retentionDays = 90;

    const notifications = {
      deleteCreatedBefore: (cutoff: Date, limit: number) => {
        cutoffs.push(cutoff);
        limits.push(limit);
        return Promise.resolve(2);
      },
    } as unknown as NotificationRepositoryPort;

    const settings: SettingsPort = {
      resolve: <T>() => Promise.resolve(retentionDays as T),
    };

    jobs = new NotificationJobsService(notifications, settings, { now: () => NOW });
  });

  it('measures the window back from now in whole days', async () => {
    await jobs.purge();

    expect(cutoffs).toEqual([new Date('2025-12-10T02:00:00Z')]);
  });

  it('follows the tenant’s own retention setting', async () => {
    retentionDays = 30;

    await jobs.purge();

    expect(cutoffs).toEqual([new Date('2026-02-08T02:00:00Z')]);
  });

  it('caps a run at a batch and reports what it removed', async () => {
    const report = await jobs.purge();

    expect(report).toEqual({ purged: 2 });
    expect(limits).toEqual([500]);
  });
});
