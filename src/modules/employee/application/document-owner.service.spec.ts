import { runInContextScope, setRequestContext, setTenantContext } from '../../../shared/context';
import type { DirectoryReaderPort } from '../domain/employee.ports';
import type { DirectoryRow } from '../domain/employee.types';
import { EmployeeDocumentOwner } from './document-owner.service';

const TENANT = '01931b7c-0000-7000-8000-0000000000t1';
const SUBJECT = '01931b7c-0000-7000-8000-0000000000e1';

/** employee.md §2 — the `employee_document` category's two-part gate. */
describe('EmployeeDocumentOwner (doc-storage §4.2 duty)', () => {
  let directory: DirectoryRow[];
  let owner: EmployeeDocumentOwner;

  beforeEach(() => {
    directory = [
      {
        employeeId: SUBJECT,
        companyId: 'co-1',
        userId: 'u-subject',
        employeeNumber: 'E-001',
        fullName: 'Budi',
        status: 'active',
        joinDate: '2024-01-01',
      },
    ];

    const reader = {
      byEmployeeIds: (ids: string[]) =>
        Promise.resolve(directory.filter((row) => ids.includes(row.employeeId))),
    } as unknown as DirectoryReaderPort;

    owner = new EmployeeDocumentOwner(reader);
  });

  const as = <T>(
    userId: string,
    permissions: string[],
    companyScope: 'all' | string[],
    body: () => Promise<T>,
  ): Promise<T> =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: TENANT, source: 'jwt' });
      setRequestContext({
        requestId: 'r-1',
        userId,
        authorization: {
          resolve: () => Promise.resolve({ permissions: new Set(permissions), companyScope }),
        },
      });
      return body();
    });

  const ref = { entityType: 'employee', entityId: SUBJECT };

  it('lets an employee read their own documents with no key at all', async () => {
    // §2: *"`employee.document.read` (self: own docs without key)"* — the clause a
    // static `@RequirePermission` cannot express, and the reason the gate is one
    // predicate rather than a key beside a resolver.
    expect(await as('u-subject', [], [], () => owner.canRead(ref))).toBe(true);
  });

  it('does not let self stretch to writing or deleting', async () => {
    expect(await as('u-subject', [], [], () => owner.canWrite(ref))).toBe(false);
    expect(await as('u-subject', [], [], () => owner.canDelete(ref))).toBe(false);
  });

  it('honours the three keys separately, as §2 lists them', async () => {
    const scope = ['co-1'];
    expect(await as('u-hr', ['employee.document.create'], scope, () => owner.canWrite(ref))).toBe(
      true,
    );
    expect(await as('u-hr', ['employee.document.create'], scope, () => owner.canDelete(ref))).toBe(
      false,
    );
    expect(await as('u-hr', ['employee.document.delete'], scope, () => owner.canDelete(ref))).toBe(
      true,
    );
  });

  it('refuses an out-of-scope employee even to a key holder', async () => {
    // Which document-storage turns into 404 — *"Out-of-scope employees are 404
    // (existence hiding)"*.
    expect(
      await as('u-hr', ['employee.document.read'], ['co-other'], () => owner.canRead(ref)),
    ).toBe(false);
  });

  it('lets a tenant-wide assignment reach every company', async () => {
    expect(await as('u-hr', ['employee.document.read'], 'all', () => owner.canRead(ref))).toBe(
      true,
    );
  });

  it('answers false for an employee that does not exist', async () => {
    directory = [];
    expect(await as('u-hr', ['employee.document.read'], 'all', () => owner.canRead(ref))).toBe(
      false,
    );
  });

  it('never matches self on a null user id', async () => {
    // An employee with no login has `user_id NULL`, and `null === undefined` is
    // false in JS but `null == undefined` is true — the kind of match that would
    // hand a system actor somebody else's documents.
    directory[0]!.userId = null;
    expect(await as('u-other', [], 'all', () => owner.canRead(ref))).toBe(false);
  });

  it('claims exactly the entity type UC-EMP-010 attaches to', () => {
    expect(owner.entityTypes).toEqual(['employee']);
    expect(owner.module).toBe('employee');
  });
});
