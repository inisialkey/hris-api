import type { NotificationPort, SendCommand } from '../../notification';
import type { SettingsPort } from '../../settings';
import { ImportExportJobsService } from './import-export-jobs.service';
import { clock, FakeDocuments, FakeExportJobs, FakeImportJobs, inScope, NOW } from './test-support';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('ImportExportJobsService — §12’s two crons', () => {
  let imports: FakeImportJobs;
  let exports_: FakeExportJobs;
  let documents: FakeDocuments;
  let sent: SendCommand[];
  let retentionDays: number;
  let service: ImportExportJobsService;

  beforeEach(() => {
    imports = new FakeImportJobs();
    exports_ = new FakeExportJobs();
    documents = new FakeDocuments();
    sent = [];
    retentionDays = 365;
    service = new ImportExportJobsService(
      imports,
      exports_,
      documents,
      {
        send: (command: SendCommand) => {
          sent.push(command);
          return Promise.resolve({ created: 1, deduped: 0, suppressed: 0 });
        },
      } as NotificationPort,
      { resolve: () => Promise.resolve(retentionDays) } as unknown as SettingsPort,
      clock,
    );
  });

  describe('cron.import-export.auto-cancel — BR-IMP-011', () => {
    it('cancels a dry-run older than 24 h and notifies its requester', async () => {
      const stale = imports.seed({
        type: 'employee.master',
        status: 'awaiting_confirmation',
        createdAt: new Date(NOW.getTime() - 25 * HOUR),
        requestedBy: 'user-a',
      });

      const report = await inScope(undefined, [], () => service.autoCancelStale());

      expect(report).toEqual({ cancelled: 1, raced: 0 });
      expect(imports.rows.get(stale.id)?.status).toBe('cancelled');
      expect(sent[0]).toMatchObject({
        templateKey: 'import-export.import_finished',
        recipients: { kind: 'users', userIds: ['user-a'] },
        params: { applied: 0 },
      });
    });

    it('leaves a dry-run inside the window alone — the two-sided half of the cron', async () => {
      const fresh = imports.seed({
        type: 'holiday.calendar',
        status: 'awaiting_confirmation',
        createdAt: new Date(NOW.getTime() - 23 * HOUR),
      });
      const report = await inScope(undefined, [], () => service.autoCancelStale());

      expect(report.cancelled).toBe(0);
      expect(imports.rows.get(fresh.id)?.status).toBe('awaiting_confirmation');
      expect(sent).toEqual([]);
    });

    it('touches nothing that is not awaiting confirmation, however old', async () => {
      const ancient = imports.seed({
        type: 'shift.roster',
        status: 'committing',
        createdAt: new Date(NOW.getTime() - 90 * DAY),
      });
      await inScope(undefined, [], () => service.autoCancelStale());
      expect(imports.rows.get(ancient.id)?.status).toBe('committing');
    });

    it('counts a confirm that landed first as a race rather than overwriting it', async () => {
      const job = imports.seed({
        type: 'employee.master',
        status: 'awaiting_confirmation',
        createdAt: new Date(NOW.getTime() - 30 * HOUR),
      });
      // The scan read the row, then somebody confirmed it.
      imports.cancelIfAwaiting = () => Promise.resolve(false);

      const report = await inScope(undefined, [], () => service.autoCancelStale());
      expect(report).toEqual({ cancelled: 0, raced: 1 });
      expect(imports.rows.get(job.id)?.status).toBe('awaiting_confirmation');
      expect(sent).toEqual([]);
    });
  });

  describe('cron.import-export.purge — §12', () => {
    const old = () => new Date(NOW.getTime() - 400 * DAY);

    it('removes a terminal import job and retires its source and error workbook', async () => {
      const job = imports.seed({
        type: 'employee.master',
        status: 'completed',
        createdAt: old(),
        fileId: 'source-1',
        errorReportFileId: 'errors-1',
      });

      const report = await inScope(undefined, [], () => service.purge());

      expect(report).toMatchObject({ importJobs: 1, files: 2 });
      expect(imports.rows.has(job.id)).toBe(false);
      // Soft delete, not a bucket call: `cron.document.purge` collects them
      // object-then-row, which is the ordering that keeps orphans impossible.
      expect(documents.softDeleted).toEqual(['source-1', 'errors-1']);
    });

    it('removes a terminal export job and retires its output', async () => {
      exports_.seed({
        type: 'employee.master',
        status: 'completed',
        createdAt: old(),
        fileId: 'out-1',
      });
      const report = await inScope(undefined, [], () => service.purge());
      expect(report).toMatchObject({ exportJobs: 1 });
      expect(documents.softDeleted).toEqual(['out-1']);
    });

    it('keeps a terminal job inside the retention window', async () => {
      const recent = imports.seed({
        type: 'employee.master',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - 10 * DAY),
      });
      const report = await inScope(undefined, [], () => service.purge());
      expect(report.importJobs).toBe(0);
      expect(imports.rows.has(recent.id)).toBe(true);
    });

    it('keeps a non-terminal job however old — BR-IMP-011 owns those, not this', async () => {
      const pending = imports.seed({
        type: 'employee.master',
        status: 'awaiting_confirmation',
        createdAt: old(),
      });
      await inScope(undefined, [], () => service.purge());
      expect(imports.rows.has(pending.id)).toBe(true);
      expect(documents.softDeleted).toEqual([]);
    });

    it('reads the window from the tenant’s setting rather than a constant', async () => {
      retentionDays = 1;
      imports.seed({
        type: 'employee.master',
        status: 'completed',
        createdAt: new Date(NOW.getTime() - 2 * DAY),
      });
      const report = await inScope(undefined, [], () => service.purge());
      expect(report.importJobs).toBe(1);
    });

    it('skips a job whose files are already gone without counting them', async () => {
      imports.seed({
        type: 'employee.master',
        status: 'cancelled',
        createdAt: old(),
        fileId: 'source-2',
        errorReportFileId: null,
      });
      const report = await inScope(undefined, [], () => service.purge());
      expect(report.files).toBe(1);
    });
  });
});
