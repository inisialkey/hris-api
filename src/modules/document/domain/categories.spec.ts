import {
  CATEGORY_POLICIES,
  categoriesForEntityType,
  clearFileOwners,
  findCategory,
  registerFileOwner,
  type FileOwner,
} from './categories';

const owner = (module: string, entityTypes: string[]): FileOwner => ({
  module,
  entityTypes,
  canWrite: () => Promise.resolve(true),
  canRead: () => Promise.resolve(true),
  canDelete: () => Promise.resolve(true),
});

describe('category registry (§4.2)', () => {
  afterEach(() => clearFileOwners());

  it('carries every row of §4.2, owned or not', () => {
    // A ceiling is a platform decision and does not become one later, which is
    // why the seven categories whose module has not shipped are still here.
    expect(Object.keys(CATEGORY_POLICIES)).toEqual([
      'punch_selfie',
      'employee_document',
      'receipt',
      'generated_document',
      'import_file',
      'candidate_file',
      'asset_document',
      'training_certificate',
      'announcement_attachment',
      'leave_attachment',
    ]);
  });

  it('treats a policy with no owner as not live', () => {
    // The whole point of registration being the gate: an unowned category has
    // nobody to answer "may I attach to this entity", so it answers nothing.
    expect(findCategory('receipt')).toBeNull();
    registerFileOwner('receipt', owner('expense', ['expense_claim']));
    expect(findCategory('receipt')?.owner.module).toBe('expense');
  });

  it('refuses a category the registry does not define', () => {
    expect(() => registerFileOwner('invented', owner('nowhere', ['x']))).toThrow(
      /no document-storage/,
    );
  });

  it('refuses a second module claiming one category', () => {
    // Two owners is two answers to "may I read this", and the wrong one would be
    // whichever module loaded last.
    registerFileOwner('receipt', owner('expense', ['expense_claim']));
    expect(() => registerFileOwner('receipt', owner('payroll', ['payslip']))).toThrow(
      /already owned by module expense/,
    );
  });

  it('is idempotent for the same owner, so a re-registered module does not fail boot', () => {
    const expense = owner('expense', ['expense_claim']);
    registerFileOwner('receipt', expense);
    expect(() => registerFileOwner('receipt', expense)).not.toThrow();
  });

  it('resolves an entity type to every live category that claims it', () => {
    registerFileOwner('employee_document', owner('employee', ['employee']));
    registerFileOwner('receipt', owner('expense', ['expense_claim']));

    expect(categoriesForEntityType('employee').map((c) => c.key)).toEqual(['employee_document']);
    expect(categoriesForEntityType('unclaimed')).toEqual([]);
  });
});

describe('the policy rows that carry a decision (§4.2)', () => {
  it('gives payslips the short TTL and refuses client deletes', () => {
    const generated = CATEGORY_POLICIES.generated_document!;
    expect(generated.downloadUrlTtlSeconds).toBe(120);
    expect(generated.clientDeletable).toBe(false);
    expect(generated.retention).toEqual({ kind: 'statutory' });
    expect(generated.sensitiveReadKey).toBe('document.download.generated_document');
  });

  it('leaves the worker-only category with no client cap at all', () => {
    // `null` is §4.2's "—", not "unbounded": there is no slot to mint.
    expect(CATEGORY_POLICIES.generated_document!.maxSizeBytes).toBeNull();
  });

  it('keeps training certificates out of the expiry scan (BR-TRN-013)', () => {
    expect(CATEGORY_POLICIES.training_certificate!.expiryReminders).toBe(false);
    expect(CATEGORY_POLICIES.employee_document!.expiryReminders).toBe(true);
  });

  it('binds the two tunable caps to the settings keys that already exist', () => {
    expect(CATEGORY_POLICIES.employee_document!.sizeSettingKey).toBe(
      'document.employee_document_max_size_mb',
    );
    expect(CATEGORY_POLICIES.receipt!.sizeSettingKey).toBe('document.receipt_max_size_mb');
    expect(CATEGORY_POLICIES.punch_selfie!.sizeSettingKey).toBeUndefined();
  });
});
