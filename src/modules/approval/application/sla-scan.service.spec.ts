import { runInContextScope, setTenantContext } from '../../../shared/context';
import type { RoleHolderPort } from '../../authz';
import type { OrgQueryPort } from '../../organization';
import type { SettingsPort } from '../../settings';
import type {
  ActionRepositoryPort,
  ApprovalDirectoryPort,
  ApprovalOutboxPort,
  AssigneeRepositoryPort,
  InstanceRepositoryPort,
  StepRepositoryPort,
} from '../domain/approval.ports';
import type { ActionType, AssigneeRow, InstanceRow, StepRow } from '../domain/approval.types';
import { InstanceLifecycleService } from './lifecycle.service';
import { SlaScanService } from './sla-scan.service';

/**
 * UC-APRV-007 and §14: *"reminder at SLA, escalation at 2×, no auto-decide ever,
 * idempotent rescan (fake clock)"*. The last three words are why every threshold
 * here goes through the `Clock` port.
 */
describe('SlaScanService (UC-APRV-007)', () => {
  const ACTIVATED = new Date('2026-03-10T00:00:00Z');

  let now: Date;
  let due: StepRow[];
  let seats: AssigneeRow[];
  let managers: string[];
  let stamps: { id: string; column: string }[];
  let actions: ActionType[];
  let emitted: { name: string; payload: Record<string, unknown> }[];
  let stepStatusWrites: number;

  const step = (over: Partial<StepRow> = {}): StepRow => ({
    id: 's-0',
    instanceId: 'i-1',
    stepIndex: 0,
    name: null,
    quorum: 'any',
    slaHours: 24,
    status: 'active',
    activatedAt: ACTIVATED,
    remindedAt: null,
    escalatedAt: null,
    decidedAt: null,
    version: 1,
    ...over,
  });

  beforeEach(() => {
    now = new Date('2026-03-11T01:00:00Z'); // 25 h — past 1×, short of 2×
    due = [step()];
    seats = [
      {
        id: 'a-1',
        stepId: 's-0',
        approverUserId: 'u-approver',
        delegateOfUserId: null,
        status: 'active',
        actedAt: null,
        version: 1,
      },
    ];
    managers = ['u-manager'];
    stamps = [];
    actions = [];
    emitted = [];
    stepStatusWrites = 0;
  });

  function build(): SlaScanService {
    const steps = {
      dueForSla: () => Promise.resolve(due),
      stamp: (id: string, column: string) => {
        stamps.push({ id, column });
        return Promise.resolve();
      },
      // Nothing in this service may write a step status (BR-APRV-010). The fakes
      // count calls so the test can assert the absence rather than assume it.
      decide: () => {
        stepStatusWrites += 1;
        return Promise.resolve(true);
      },
      activate: () => {
        stepStatusWrites += 1;
        return Promise.resolve(true);
      },
      skipRemaining: () => {
        stepStatusWrites += 1;
        return Promise.resolve();
      },
    } as unknown as StepRepositoryPort;

    const instances = {
      findById: () => Promise.resolve({ id: 'i-1', companyId: 'co-1' } as InstanceRow),
      advance: () => Promise.resolve(true),
    } as unknown as InstanceRepositoryPort;

    const assignees = {
      listByStep: () => Promise.resolve(seats),
    } as unknown as AssigneeRepositoryPort;

    const actionRepo = {
      append: (values: { action: ActionType }) => {
        actions.push(values.action);
        return Promise.resolve({} as never);
      },
    } as unknown as ActionRepositoryPort;

    const directory = {
      employeeIdOf: () => Promise.resolve('e-approver'),
    } as unknown as ApprovalDirectoryPort;

    const org = { directManagers: () => Promise.resolve(managers) } as unknown as OrgQueryPort;
    const roles = {
      findIdByKey: () => Promise.resolve('role-hr'),
      holderUserIds: () => Promise.resolve(['u-hr']),
    } as unknown as RoleHolderPort;
    const settings = { resolve: () => Promise.resolve('hr_admin') } as unknown as SettingsPort;

    const outbox = {
      emit: (event: { name: string; payload: Record<string, unknown> }) => {
        emitted.push({ name: event.name, payload: event.payload });
        return Promise.resolve();
      },
    } as unknown as ApprovalOutboxPort;

    return new SlaScanService(
      steps,
      instances,
      assignees,
      actionRepo,
      directory,
      org,
      roles,
      settings,
      new InstanceLifecycleService(instances, steps, outbox),
      { now: () => now },
    );
  }

  const run = () =>
    runInContextScope({}, () => {
      setTenantContext({ tenantId: 't-1', source: 'jwt' });
      return build().run();
    });

  it('reminds once past the SLA and never touches a step status', async () => {
    const report = await run();

    expect(report).toEqual({ reminded: 1, escalated: 0 });
    expect(stamps).toEqual([{ id: 's-0', column: 'remindedAt' }]);
    expect(actions).toEqual(['reminded']);
    expect(stepStatusWrites).toBe(0);
  });

  it('is idempotent on a rescan — the stamp is the guard', async () => {
    due = [step({ remindedAt: new Date('2026-03-11T00:30:00Z') })];
    const report = await run();

    expect(report).toEqual({ reminded: 0, escalated: 0 });
    expect(stamps).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('escalates at 2× to each assignee’s direct manager', async () => {
    now = new Date('2026-03-12T01:00:00Z'); // 49 h
    due = [step({ remindedAt: new Date('2026-03-11T00:30:00Z') })];

    const report = await run();

    expect(report).toEqual({ reminded: 0, escalated: 1 });
    expect(stamps).toEqual([{ id: 's-0', column: 'escalatedAt' }]);
    expect(actions).toEqual(['escalated']);
    expect(emitted[0]).toEqual({
      name: 'approval.step.escalated',
      payload: { instanceId: 'i-1', stepId: 's-0', escalatedToUserIds: ['u-manager'] },
    });
  });

  it('stamps both rungs when a step crosses them between two scans', async () => {
    // A reminder sent after an escalation is a notice about a deadline that has
    // already been overtaken, so the reminder stamp is set without a reminder.
    now = new Date('2026-03-12T01:00:00Z');
    const report = await run();

    expect(report).toEqual({ reminded: 0, escalated: 1 });
    expect(stamps.map((stamp) => stamp.column)).toEqual(['escalatedAt', 'remindedAt']);
    expect(actions).toEqual(['escalated']);
  });

  it('falls back to the configured role when no manager resolves', async () => {
    now = new Date('2026-03-12T01:00:00Z');
    managers = [];

    await run();

    expect(emitted[0]?.payload.escalatedToUserIds).toEqual(['u-hr']);
  });

  it('escalates up one line per active assignee and dedupes a shared manager', async () => {
    now = new Date('2026-03-12T01:00:00Z');
    seats = [
      { ...seats[0]!, id: 'a-1', approverUserId: 'u-one' },
      { ...seats[0]!, id: 'a-2', approverUserId: 'u-two' },
      { ...seats[0]!, id: 'a-3', approverUserId: 'u-acted', status: 'approved' },
    ];

    await run();

    expect(emitted[0]?.payload.escalatedToUserIds).toEqual(['u-manager']);
  });
});
