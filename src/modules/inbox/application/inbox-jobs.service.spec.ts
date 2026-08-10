import type { SettingsPort } from '../../settings';
import type { InboxRepositoryPort } from '../domain/inbox.ports';
import { InboxJobsService } from './inbox-jobs.service';

const NOW = new Date('2026-03-10T02:00:00Z');

describe('InboxJobsService (cron.inbox.purge, BR-INB-010)', () => {
  let cutoff: Date | null;
  let limit: number | null;
  let service: InboxJobsService;

  beforeEach(() => {
    cutoff = null;
    limit = null;

    const items = {
      deleteClosedBefore: (at: Date, batch: number) => {
        cutoff = at;
        limit = batch;
        return Promise.resolve(7);
      },
    } as unknown as InboxRepositoryPort;

    const settings = { resolve: <T>() => Promise.resolve(180 as T) } as unknown as SettingsPort;

    service = new InboxJobsService(items, settings, { now: () => NOW });
  });

  it('measures the window from the tenant’s own retention setting', async () => {
    expect(await service.purge()).toEqual({ purged: 7 });
    expect(cutoff).toEqual(new Date('2025-09-11T02:00:00Z'));
  });

  it('bounds the batch rather than the window', async () => {
    // The job is idempotent and the next run takes what this one left, so the
    // ceiling is a lock-duration choice and never a correctness one.
    await service.purge();
    expect(limit).toBe(500);
  });
});
