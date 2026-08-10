import { FIELD_ENTRIES } from '../../../shared/validation-details';
import { clearDefinitions, registerImportDefinition } from '../domain/definitions';
import { DefinitionAccessService } from './definition-access.service';
import { ImportJobsService } from './import-jobs.service';
import { clock, FakeDocuments, FakeImportJobs, importDefinition, inScope } from './test-support';

const PERMISSION = 'employee.master.import';

describe('ImportJobsService', () => {
  let jobs: FakeImportJobs;
  let documents: FakeDocuments;
  let service: ImportJobsService;

  beforeEach(() => {
    clearDefinitions();
    registerImportDefinition(importDefinition());
    jobs = new FakeImportJobs();
    documents = new FakeDocuments();
    documents.seedFile({ id: 'file-1' });
    service = new ImportJobsService(jobs, documents, clock, new DefinitionAccessService());
  });

  describe('UC-IMP-001 — start', () => {
    it('creates the job and re-parents the file to it in the same act', async () => {
      const started = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-1'),
      );

      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.status).toBe('uploaded');
      // §14: *"slot user-parented; `POST /imports` re-parents (files row entity = job)"*.
      expect(documents.files.get('file-1')).toMatchObject({
        entityType: 'import_job',
        entityId: started.value.id,
      });
    });

    it('refuses an unregistered type as VAL_INVALID_ENUM on `type`, never a 404 on the route', async () => {
      const started = await inScope('user-a', [PERMISSION], () =>
        service.start('holiday.calendar', 'file-1'),
      );
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('VAL_VALIDATION_FAILED');
      expect(started.error.details?.[FIELD_ENTRIES]).toEqual([
        expect.objectContaining({ field: 'type', code: 'VAL_INVALID_ENUM' }),
      ]);
    });

    it('hides a definition the caller may not run behind the same answer', async () => {
      // §7 filters `GET /definitions` by permission, so a `POST` answering 403
      // would hand back the fact that list was built to withhold.
      const started = await inScope('user-a', [], () => service.start('employee.master', 'file-1'));
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('§14: refuses another uploader’s fileId with a 404 that says nothing else', async () => {
      documents.seedFile({ id: 'file-2', uploadedBy: 'user-b' });
      const started = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-2'),
      );
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('SYS_NOT_FOUND');
    });

    it('refuses a file of the wrong category and one already claimed by a job', async () => {
      documents.seedFile({ id: 'file-3', category: 'receipt' });
      documents.seedFile({ id: 'file-4', entityType: 'import_job', entityId: 'other-job' });

      for (const fileId of ['file-3', 'file-4', 'file-missing']) {
        const started = await inScope('user-a', [PERMISSION], () =>
          service.start('employee.master', fileId),
        );
        expect(started.ok).toBe(false);
        if (!started.ok) expect(started.error.code).toBe('SYS_NOT_FOUND');
      }
    });

    it('§14: a second start of the same type is 409 carrying the winner’s id', async () => {
      const first = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-1'),
      );
      documents.seedFile({ id: 'file-5' });
      const second = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-5'),
      );

      expect(second.ok).toBe(false);
      if (!second.ok && first.ok) {
        expect(second.error.code).toBe('IMP_ALREADY_RUNNING');
        expect(second.error.details).toEqual({ activeJobId: first.value.id });
      }
    });

    it('lets a finished import of the same type be followed by a new one', async () => {
      const first = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-1'),
      );
      if (!first.ok) throw new Error('expected a job');
      await jobs.update(first.value.id, { status: 'completed' });

      documents.seedFile({ id: 'file-6' });
      const second = await inScope('user-a', [PERMISSION], () =>
        service.start('employee.master', 'file-6'),
      );
      expect(second.ok).toBe(true);
    });
  });

  describe('UC-IMP-003 / UC-IMP-004 — confirm and cancel', () => {
    it('confirms from awaiting_confirmation and records who did it', async () => {
      const job = jobs.seed({ type: 'employee.master', status: 'awaiting_confirmation' });
      const confirmed = await inScope('user-b', [PERMISSION], () => service.confirm(job.id));

      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      // §2: *"any definition-permission holder may confirm — jobs are tenant
      // artifacts, not personal drafts"*. `user-b` did not upload it.
      expect(confirmed.value).toMatchObject({ status: 'committing', confirmedBy: 'user-b' });
    });

    it('§9: the second of two simultaneous confirms gets IMP_INVALID_STATE naming committing', async () => {
      const job = jobs.seed({ type: 'employee.master', status: 'awaiting_confirmation' });
      await inScope('user-a', [PERMISSION], () => service.confirm(job.id));
      const second = await inScope('user-b', [PERMISSION], () => service.confirm(job.id));

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('IMP_INVALID_STATE');
      expect(second.error.details).toEqual({ status: 'committing' });
    });

    it('refuses a confirm outside awaiting_confirmation and names the state', async () => {
      const job = jobs.seed({ type: 'employee.master', status: 'uploaded' });
      const confirmed = await inScope('user-a', [PERMISSION], () => service.confirm(job.id));
      expect(confirmed.ok).toBe(false);
      if (!confirmed.ok) expect(confirmed.error.details).toEqual({ status: 'uploaded' });
    });

    it('cancels from awaiting_confirmation only', async () => {
      const job = jobs.seed({ type: 'employee.master', status: 'awaiting_confirmation' });
      const cancelled = await inScope('user-a', [PERMISSION], () => service.cancel(job.id));
      expect(cancelled.ok).toBe(true);
      if (cancelled.ok) expect(cancelled.value.status).toBe('cancelled');

      const committing = jobs.seed({ type: 'employee.master', status: 'committing' });
      const refused = await inScope('user-a', [PERMISSION], () => service.cancel(committing.id));
      expect(refused.ok).toBe(false);
    });

    it('gates confirm and cancel on the definition’s permission, not on job.read', async () => {
      const job = jobs.seed({ type: 'employee.master', status: 'awaiting_confirmation' });
      const confirmed = await inScope('user-a', ['import-export.job.read'], () =>
        service.confirm(job.id),
      );
      expect(confirmed.ok).toBe(false);
      if (!confirmed.ok) expect(confirmed.error.code).toBe('VAL_VALIDATION_FAILED');
    });

    it('answers 404 for a job that does not exist', async () => {
      const found = await inScope('user-a', [PERMISSION], () => service.find('missing'));
      expect(found.ok).toBe(false);
      if (!found.ok) expect(found.error.code).toBe('SYS_NOT_FOUND');
    });
  });
});
