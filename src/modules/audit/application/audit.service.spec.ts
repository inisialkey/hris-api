import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { NewAuditLog } from '../domain/audit.ports';
import { AuditService } from './audit.service';

/** UC-AUD-003 + BR-AUD-008: one row per access, both identities, nothing swallowed. */
describe('AuditService.sensitiveRead', () => {
  let appended: NewAuditLog[];
  let appendFails: boolean;

  function build(): AuditService {
    const repository = {
      append: (entry: NewAuditLog) => {
        if (appendFails) return Promise.reject(new Error('insert exploded'));
        appended.push(entry);
        return Promise.resolve('audit-1');
      },
      findById: () => Promise.resolve(null),
      list: () => Promise.resolve({ rows: [], hasMore: false }),
      listForAnchorDay: () => Promise.resolve([]),
    };
    return new AuditService(repository);
  }

  function inScope(
    fn: () => Promise<void>,
    over: { userId?: string; impersonatorId?: string } = { userId: 'u1' },
  ): Promise<void> {
    return runInContextScope({}, async () => {
      setTenantContext({ tenantId: 't1', source: 'jwt', impersonatorId: over.impersonatorId });
      setRequestContext({ requestId: 'req-1', userId: over.userId });
      await fn();
    });
  }

  beforeEach(() => {
    appended = [];
    appendFails = false;
  });

  it('files the read under the acting user with the request id', async () => {
    await inScope(async () => {
      await build().sensitiveRead('audit.log.queried', 'audit_log', undefined, { filters: {} });
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      tenantId: 't1',
      actorType: 'user',
      actorUserId: 'u1',
      requestId: 'req-1',
      action: 'audit.log.queried',
      entityType: 'audit_log',
    });
  });

  it('leaves occurredAt to the database', async () => {
    // §9: one clock for every pod. A `Date` minted here would put pod skew into
    // the column the cursor orders by.
    await inScope(async () => {
      await build().sensitiveRead('audit.log.queried', 'audit_log');
    });
    expect(appended[0]?.occurredAt).toBeUndefined();
  });

  it('records both identities when the request is impersonated', async () => {
    await inScope(
      async () => {
        await build().sensitiveRead('employee.sensitive.revealed', 'employees', 'e1');
      },
      { userId: 'u1', impersonatorId: 'platform-op-1' },
    );

    // BR-AUD-008: the impersonated user acted, the operator is named beside
    // them. Neither is inferred from the other.
    expect(appended[0]).toMatchObject({
      actorType: 'user',
      actorUserId: 'u1',
      impersonatorId: 'platform-op-1',
    });
  });

  it('marks a userless caller as a system actor', async () => {
    await inScope(async () => {
      await build().sensitiveRead('document.download.generated_document', 'files', 'f1');
    }, {});
    expect(appended[0]).toMatchObject({ actorType: 'system', actorUserId: undefined });
  });

  it('fails closed — an insert failure reaches the caller', async () => {
    // The whole promise of a sensitive-read audit is that it cannot be dropped.
    // A `try/catch` in the service would turn that into a best effort silently.
    appendFails = true;
    await expect(
      inScope(async () => {
        await build().sensitiveRead('audit.log.queried', 'audit_log');
      }),
    ).rejects.toThrow('insert exploded');
  });
});
