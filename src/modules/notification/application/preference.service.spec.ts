import { runInContextScope, setRequestContext } from '../../../shared/context';
import type { OptOut, PreferenceRepositoryPort } from '../domain/notification.ports';
import type { NotificationChannel } from '../domain/notification.types';
import { TEMPLATES } from '../domain/templates';
import { PreferenceService } from './preference.service';

describe('PreferenceService (UC-NTF-005, BR-NTF-005)', () => {
  let stored: OptOut[];
  let written: { op: 'in' | 'out'; templateKey: string; channel: NotificationChannel }[];
  let preferences: PreferenceService;

  beforeEach(() => {
    stored = [];
    written = [];

    const repository: PreferenceRepositoryPort = {
      listForUser: () => Promise.resolve(stored),
      optedOutChannels: () => Promise.resolve(new Map()),
      optOut: (_userId, templateKey, channel) => {
        written.push({ op: 'out', templateKey, channel });
        return Promise.resolve();
      },
      optIn: (_userId, templateKey, channel) => {
        written.push({ op: 'in', templateKey, channel });
        return Promise.resolve();
      },
    };

    preferences = new PreferenceService(repository);
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      setRequestContext({ requestId: 'r-1', userId: 'u-1' });
      return fn();
    });

  it('renders every registered template, not only the ones with stored rows', async () => {
    const matrix = await run(() => preferences.matrix());

    expect(matrix).toHaveLength(Object.keys(TEMPLATES).length);
    expect(matrix.every((row) => row.channels.length > 0)).toBe(true);
  });

  it('groups by the module the key names', async () => {
    const matrix = await run(() => preferences.matrix());
    const row = matrix.find((entry) => entry.templateKey === 'import-export.import_finished');

    expect(row?.module).toBe('import-export');
  });

  it('reads an opt-out row back as a disabled cell', async () => {
    stored = [{ templateKey: 'announcement.published', channel: 'push' }];

    const matrix = await run(() => preferences.matrix());
    const row = matrix.find((entry) => entry.templateKey === 'announcement.published');

    expect(row?.channels).toEqual([
      { channel: 'in_app', enabled: true },
      { channel: 'push', enabled: false },
    ]);
  });

  it('reports a mandatory template as enabled even if a row says otherwise', async () => {
    // A row that arrived some other way — a bad migration, a direct write — must
    // not read back as an honoured opt-out on a security notice.
    stored = [{ templateKey: 'auth.password_changed', channel: 'email' }];

    const matrix = await run(() => preferences.matrix());
    const row = matrix.find((entry) => entry.templateKey === 'auth.password_changed');

    expect(row?.mandatory).toBe(true);
    expect(row?.channels).toEqual([{ channel: 'email', enabled: true }]);
  });

  it('refuses a toggle on a mandatory template with NTF_TEMPLATE_MANDATORY', async () => {
    const result = await run(() => preferences.toggle('payroll.payslip_published', 'push', false));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('NTF_TEMPLATE_MANDATORY');
    expect(written).toHaveLength(0);
  });

  it('refuses a channel the template does not declare', async () => {
    // §8's second rule, and the reason it is not a DTO decorator: it needs the
    // other field to answer.
    const result = await run(() => preferences.toggle('announcement.published', 'email', false));

    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
    expect(written).toHaveLength(0);
  });

  it('refuses a template key outside the registry', async () => {
    const result = await run(() => preferences.toggle('payroll.made_up', 'push', false));

    expect(!result.ok && result.error.code).toBe('VAL_VALIDATION_FAILED');
  });

  it('writes an opt-out row when disabling and removes it when enabling', async () => {
    await run(() => preferences.toggle('announcement.published', 'push', false));
    await run(() => preferences.toggle('announcement.published', 'push', true));

    expect(written).toEqual([
      { op: 'out', templateKey: 'announcement.published', channel: 'push' },
      { op: 'in', templateKey: 'announcement.published', channel: 'push' },
    ]);
  });
});
