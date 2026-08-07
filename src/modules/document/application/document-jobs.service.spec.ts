import type { SettingsPort } from '../../settings';
import { clearFileOwners, registerFileOwner, type FileOwner } from '../domain/categories';
import type { FileRepositoryPort, StoragePort } from '../domain/document.ports';
import type { FileRow } from '../domain/document.types';
import { DocumentJobsService } from './document-jobs.service';

const DAY = 24 * 3_600_000;

describe('DocumentJobsService (§12)', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let rows: FileRow[];
  let removed: string[];
  let settingValues: Record<string, number>;
  let jobs: DocumentJobsService;

  const file = (over: Partial<FileRow> & { id: string }): FileRow => ({
    module: 'employee',
    entityType: 'employee',
    entityId: 'e-1',
    category: 'employee_document',
    originalName: 'ktp.png',
    storagePath: `tenants/t/employee/e-1/${over.id}_ktp.png`,
    mime: 'image/png',
    sizeBytes: 9,
    sha256: 'abc',
    status: 'committed',
    commitFailureCode: null,
    documentExpiresAt: null,
    expiryRemindedAt: null,
    uploadedBy: 'u-1',
    createdAt: NOW,
    deletedAt: null,
    ...over,
  });

  const owner: FileOwner = {
    module: 'employee',
    entityTypes: ['employee'],
    canWrite: () => Promise.resolve(true),
    canRead: () => Promise.resolve(true),
    canDelete: () => Promise.resolve(true),
  };

  const live = () => rows.filter((row) => !row.hardDeleted);

  beforeEach(() => {
    clearFileOwners();
    registerFileOwner('employee_document', owner);

    rows = [];
    removed = [];
    settingValues = { 'document.expiry_reminder_days': 30 };

    const repository = {
      staleStaged: (before: Date) =>
        Promise.resolve(live().filter((row) => row.status === 'staged' && row.createdAt < before)),
      hardDelete: (id: string) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) (row as FileRow & { hardDeleted?: boolean }).hardDeleted = true;
        return Promise.resolve();
      },
      dueForExpiryReminder: (onOrBefore: string) =>
        Promise.resolve(
          live().filter(
            (row) =>
              row.status === 'committed' &&
              row.documentExpiresAt !== null &&
              row.documentExpiresAt <= onOrBefore &&
              row.expiryRemindedAt === null,
          ),
        ),
      stampExpiryReminded: (id: string, at: Date) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) row.expiryRemindedAt = at;
        return Promise.resolve();
      },
      softDeletedOnOrBefore: (at: Date) =>
        Promise.resolve(live().filter((row) => row.deletedAt !== null && row.deletedAt <= at)),
      committedCreatedBefore: (category: string, before: Date) =>
        Promise.resolve(
          live().filter(
            (row) =>
              row.category === category &&
              row.status === 'committed' &&
              row.createdAt < before &&
              row.deletedAt === null,
          ),
        ),
    } as unknown as FileRepositoryPort;

    const storage = {
      remove: (path: string) => {
        removed.push(path);
        return Promise.resolve();
      },
    } as unknown as StoragePort;

    const settings = {
      resolve: (key: string) => {
        const value = settingValues[key];
        // The real port throws on an unregistered key, and this job must never
        // reach one — that is what the `findCategory` guard in `purge` is for.
        if (value === undefined) return Promise.reject(new Error(`unknown setting ${key}`));
        return Promise.resolve(value);
      },
    } as unknown as SettingsPort;

    jobs = new DocumentJobsService(repository, storage, settings, { now: () => NOW });
  });

  afterEach(() => clearFileOwners());

  describe('cron.document.staged-sweep (BR-DOC-003)', () => {
    it('purges a staged row past 24 h and leaves a fresh one', async () => {
      rows = [
        file({ id: 'old', status: 'staged', createdAt: new Date(NOW.getTime() - 25 * 3_600_000) }),
        file({ id: 'fresh', status: 'staged', createdAt: new Date(NOW.getTime() - 3_600_000) }),
      ];

      expect(await jobs.sweepStaged()).toEqual({ purgedRows: 1 });
      expect(removed).toEqual([]); // the staging lifecycle already took the object
      expect(live().map((row) => row.id)).toEqual(['fresh']);
    });
  });

  describe('cron.document.expiry-scan (UC-DOC-006)', () => {
    it('reminds once and stamps, so a second run is a no-op', async () => {
      rows = [file({ id: 'ktp', documentExpiresAt: '2026-03-20' })];

      expect(await jobs.scanExpiry()).toEqual({ reminded: 1, skipped: 0 });
      expect(rows[0]?.expiryRemindedAt).toEqual(NOW);
      expect(await jobs.scanExpiry()).toEqual({ reminded: 0, skipped: 0 });
    });

    it('respects the configured window rather than a fixed horizon', async () => {
      rows = [file({ id: 'far', documentExpiresAt: '2026-04-05' })];

      settingValues['document.expiry_reminder_days'] = 7;
      expect(await jobs.scanExpiry()).toEqual({ reminded: 0, skipped: 0 });

      settingValues['document.expiry_reminder_days'] = 60;
      expect(await jobs.scanExpiry()).toEqual({ reminded: 1, skipped: 0 });
    });

    it('skips a category whose reminders were turned off, without stamping it', async () => {
      // BR-TRN-013 moved the date to the credential row; a stamp here would mark
      // as handled a file nothing will ever remind about.
      rows = [
        file({ id: 'cert', category: 'training_certificate', documentExpiresAt: '2026-03-15' }),
      ];

      expect(await jobs.scanExpiry()).toEqual({ reminded: 0, skipped: 1 });
      expect(rows[0]?.expiryRemindedAt).toBeNull();
    });
  });

  describe('cron.document.purge (BR-DOC-009/010)', () => {
    it('removes the object before the row', async () => {
      rows = [file({ id: 'gone', deletedAt: new Date(NOW.getTime() - DAY) })];

      expect(await jobs.purge()).toEqual({ purged: 1, retained: 0 });
      expect(removed).toEqual(['tenants/t/employee/e-1/gone_ktp.png']);
      expect(live()).toEqual([]);
    });

    it('never collects a statutory category, however long it has been deleted', async () => {
      rows = [
        file({
          id: 'payslip',
          category: 'generated_document',
          deletedAt: new Date(NOW.getTime() - 4000 * DAY),
        }),
      ];

      expect(await jobs.purge()).toEqual({ purged: 0, retained: 1 });
      expect(removed).toEqual([]);
    });

    it('holds a soft-deleted row until its retention window has run', async () => {
      registerFileOwner('candidate_file', { ...owner, entityTypes: ['candidate'] });
      settingValues['recruitment.candidate_retention_days'] = 90;
      rows = [
        file({
          id: 'cv',
          category: 'candidate_file',
          entityType: 'candidate',
          deletedAt: new Date(NOW.getTime() - 30 * DAY),
        }),
      ];

      expect(await jobs.purge()).toEqual({ purged: 0, retained: 1 });

      rows[0]!.deletedAt = new Date(NOW.getTime() - 120 * DAY);
      expect(await jobs.purge()).toEqual({ purged: 1, retained: 0 });
    });

    it('ages a live selfie out from its creation, no delete involved', async () => {
      // BR-DOC-010's other population: nobody deletes a punch selfie, it simply
      // stops being kept — and the punch row keeps the sha256 (ADR-0009).
      registerFileOwner('punch_selfie', { ...owner, entityTypes: ['attendance_record'] });
      settingValues['attendance.selfie_retention_months'] = 12;
      rows = [
        file({
          id: 'selfie',
          category: 'punch_selfie',
          entityType: 'attendance_record',
          createdAt: new Date(NOW.getTime() - 400 * DAY),
        }),
        file({
          id: 'recent',
          category: 'punch_selfie',
          entityType: 'attendance_record',
          createdAt: new Date(NOW.getTime() - 10 * DAY),
        }),
      ];

      expect(await jobs.purge()).toEqual({ purged: 1, retained: 0 });
      expect(live().map((row) => row.id)).toEqual(['recent']);
    });

    it('does not resolve a retention key whose module has not shipped', async () => {
      // `attendance.selfie_retention_months` is not in the settings registry yet
      // and the real port throws on an unknown key. Nothing owns `punch_selfie`
      // here, so no rows of it can exist and the key is never asked for.
      rows = [file({ id: 'ordinary', deletedAt: new Date(NOW.getTime() - DAY) })];

      await expect(jobs.purge()).resolves.toEqual({ purged: 1, retained: 0 });
    });
  });
});

declare module '../domain/document.types' {
  interface FileRow {
    /** Test-fake bookkeeping: the real repository deletes the row outright. */
    hardDeleted?: boolean;
  }
}
