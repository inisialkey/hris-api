import type {
  ApprovalDirectoryPort,
  AssigneeRepositoryPort,
  InstanceRepositoryPort,
  StepRepositoryPort,
} from '../domain/approval.ports';
import type { AssigneeRow, InstanceRow, StepRow } from '../domain/approval.types';
import { ApprovalTaskService } from './approval-task.service';

const ACTIVATED = new Date('2026-03-10T02:00:00Z');

const INSTANCE = {
  id: 'instance-1',
  companyId: 'company-1',
  requestType: 'leave.request',
  requestId: 'request-1',
  requesterEmployeeId: 'employee-1',
  requesterUserId: 'user-requester',
  status: 'in_progress',
  chainSnapshot: { steps: [] },
  context: { dayCount: 3 },
  currentStepIndex: 0,
  isStuck: false,
  version: 1,
  completedAt: null,
  createdAt: ACTIVATED,
} as unknown as InstanceRow;

const STEP: StepRow = {
  id: 'step-1',
  instanceId: 'instance-1',
  stepIndex: 0,
  name: 'Direct manager',
  quorum: 'any',
  slaHours: 24,
  status: 'active',
  activatedAt: ACTIVATED,
  remindedAt: null,
  escalatedAt: null,
  decidedAt: null,
  version: 1,
};

function seat(overrides: Partial<AssigneeRow> = {}): AssigneeRow {
  return {
    id: 'seat-1',
    stepId: 'step-1',
    approverUserId: 'user-a',
    delegateOfUserId: null,
    status: 'active',
    actedAt: null,
    version: 1,
    ...overrides,
  };
}

/** A-199 (hris-handbook PR #33) — §7's read port for inbox.md. */
describe('ApprovalTaskService.stepTasks', () => {
  let step: StepRow | null;
  let seats: AssigneeRow[];
  let service: ApprovalTaskService;

  beforeEach(() => {
    step = STEP;
    seats = [seat()];

    const steps = { findById: () => Promise.resolve(step) } as unknown as StepRepositoryPort;
    const instances = {
      findById: () => Promise.resolve(INSTANCE),
    } as unknown as InstanceRepositoryPort;
    const assignees = {
      listByStep: () => Promise.resolve(seats),
    } as unknown as AssigneeRepositoryPort;
    const directory: ApprovalDirectoryPort = {
      byEmployeeId: () => Promise.resolve(null),
      employeeIdOf: () => Promise.resolve(null),
      byUserIds: (userIds) =>
        Promise.resolve(
          new Map(
            [...userIds].map((userId) => [
              userId,
              {
                employeeId: `employee-${userId}`,
                userId,
                companyId: 'company-1',
                fullName: userId === 'user-requester' ? 'Budi Santoso' : 'Sari Wijaya',
              },
            ]),
          ),
        ),
    };

    service = new ApprovalTaskService(instances, steps, assignees, directory);
  });

  it('carries the request identity and the requester’s name', async () => {
    const tasks = await service.stepTasks('step-1');

    expect(tasks).toMatchObject({
      instanceId: 'instance-1',
      stepId: 'step-1',
      requestType: 'leave.request',
      requestId: 'request-1',
      requesterUserId: 'user-requester',
      requesterName: 'Budi Santoso',
      context: { dayCount: 3 },
    });
  });

  it('sums the SLA into a deadline rather than shipping two fields', async () => {
    // BR-INB-009 sorts on the sum, and `sla_hours` lives in the chain snapshot
    // this module owns. Calendar hours per BR-APRV-010.
    expect((await service.stepTasks('step-1'))?.dueAt).toEqual(new Date('2026-03-11T02:00:00Z'));
  });

  it('has no deadline when the step carries no SLA', async () => {
    step = { ...STEP, slaHours: null };
    expect((await service.stepTasks('step-1'))?.dueAt).toBeNull();
  });

  it('has no deadline before the step is activated', async () => {
    step = { ...STEP, activatedAt: null };
    expect((await service.stepTasks('step-1'))?.dueAt).toBeNull();
  });

  it('pairs each seat’s row id with its user and the person it acts for', async () => {
    // The assignee **row** id is what BR-INB-004 makes the dedupe key, and it is
    // the one identifier `approval.step.activated` does not carry.
    seats = [
      seat(),
      seat({ id: 'seat-2', approverUserId: 'user-delegate', delegateOfUserId: 'user-b' }),
    ];

    const tasks = await service.stepTasks('step-1');

    expect(tasks?.tasks).toEqual([
      { assigneeId: 'seat-1', userId: 'user-a', delegateOfUserId: null, delegateOfName: null },
      {
        assigneeId: 'seat-2',
        userId: 'user-delegate',
        delegateOfUserId: 'user-b',
        delegateOfName: 'Sari Wijaya',
      },
    ]);
  });

  it('returns every seat, not only the ones still active', async () => {
    // A handler running after the step decided still materializes the items its
    // closure event is about to close — BR-INB-001's *"a stale item misleads
    // nobody"*, and the convergence BR-INB-004's idempotence promises.
    seats = [seat({ status: 'approved', actedAt: ACTIVATED })];
    expect((await service.stepTasks('step-1'))?.tasks).toHaveLength(1);
  });

  it('returns null when the step is gone', async () => {
    step = null;
    expect(await service.stepTasks('step-1')).toBeNull();
  });
});
