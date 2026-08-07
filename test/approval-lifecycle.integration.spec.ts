import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import { OutboxRepository } from '../src/database/outbox.repository';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import { AuditService } from '../src/modules/audit/application/audit.service';
import { registerAuditedTables } from '../src/modules/audit/domain/audited-tables';
import { AuditRepository } from '../src/modules/audit/infrastructure/audit.repository';
import { ActivationService } from '../src/modules/approval/application/activation.service';
import { ApprovalService } from '../src/modules/approval/application/approval.service';
import { DecideUseCase } from '../src/modules/approval/application/decide.use-case';
import { InstanceLifecycleService } from '../src/modules/approval/application/lifecycle.service';
import { SubmitUseCase } from '../src/modules/approval/application/submit.use-case';
import type { StepConfig } from '../src/modules/approval/domain/approval.types';
import { ActionRepository } from '../src/modules/approval/infrastructure/action.repository';
import { AssigneeRepository } from '../src/modules/approval/infrastructure/assignee.repository';
import { ChainRepository } from '../src/modules/approval/infrastructure/chain.repository';
import { DelegationRepository } from '../src/modules/approval/infrastructure/delegation.repository';
import { ApprovalDirectoryRepository } from '../src/modules/approval/infrastructure/directory.repository';
import { InstanceRepository } from '../src/modules/approval/infrastructure/instance.repository';
import { StepRepository } from '../src/modules/approval/infrastructure/step.repository';
import type { RoleHolderPort } from '../src/modules/authz';
import type { OrgQueryPort } from '../src/modules/organization';
import type { SettingsPort } from '../src/modules/settings';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * The engine end to end against a real database.
 *
 * The unit suite proves each decision with fakes that answer on command. Three
 * things only a database proves, and §14 names all three: the port call is
 * **same-transaction** (a module rollback leaves no instance rows), the
 * `any`-quorum race is decided by the version guard rather than by luck, and a
 * chain edit does not reach an instance already running its snapshot.
 */
describe('approval engine lifecycle', () => {
  let db: TestDatabase;
  let connection: ConnectionProvider;
  let unitOfWork: UnitOfWork;
  let approvals: ApprovalService;
  let chains: ChainRepository;
  let instances: InstanceRepository;

  const NOW = new Date('2026-03-10T02:00:00Z');
  const tenantId = uuidv7();
  const companyId = uuidv7();
  const requesterUser = uuidv7();
  const requesterEmployee = uuidv7();
  const managerUser = uuidv7();
  const managerEmployee = uuidv7();
  const secondUser = uuidv7();
  const secondEmployee = uuidv7();

  let managers: string[] = [];

  const org = {
    directManagers: (_employeeId: string, levels: number) =>
      Promise.resolve(levels === 1 ? managers : []),
    positionHolders: () => Promise.resolve([]),
  } as unknown as OrgQueryPort;

  const roles = {
    findIdByKey: () => Promise.resolve(null),
    holderUserIds: () => Promise.resolve([]),
    exists: () => Promise.resolve(true),
  } as unknown as RoleHolderPort;

  const settings = { resolve: () => Promise.resolve('hr_admin') } as unknown as SettingsPort;

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    registerAuditedTables({ approval_chains: {}, approval_delegations: {} });

    const audit = new AuditService(new AuditRepository(connection));
    const clock = { now: () => NOW };

    chains = new ChainRepository(connection, audit, clock);
    instances = new InstanceRepository(connection);
    const steps = new StepRepository(connection);
    const assignees = new AssigneeRepository(connection);
    const actions = new ActionRepository(connection);
    const delegations = new DelegationRepository(connection, audit);
    const directory = new ApprovalDirectoryRepository(connection);
    const outbox = new OutboxRepository(connection, clock);

    const activation = new ActivationService(
      steps,
      assignees,
      actions,
      delegations,
      org,
      roles,
      settings,
      outbox,
      clock,
    );
    const lifecycle = new InstanceLifecycleService(instances, steps, outbox);
    const submit = new SubmitUseCase(
      chains,
      instances,
      steps,
      actions,
      directory,
      activation,
      lifecycle,
      clock,
    );
    const decide = new DecideUseCase(
      instances,
      steps,
      assignees,
      actions,
      activation,
      lifecycle,
      clock,
    );
    approvals = new ApprovalService(
      submit,
      decide,
      lifecycle,
      instances,
      steps,
      assignees,
      actions,
      clock,
    );

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'aprv-lifecycle',
    ]);
    await db.migrator.query(
      'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
      [companyId, tenantId, 'C1', 'Lifecycle Co'],
    );

    for (const [userId, employeeId, name] of [
      [requesterUser, requesterEmployee, 'Requester'],
      [managerUser, managerEmployee, 'Manager'],
      [secondUser, secondEmployee, 'Second'],
    ] as const) {
      await db.migrator.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, $3, 'x', 'active')`,
        [userId, tenantId, `${name.toLowerCase()}@example.test`],
      );
      await db.migrator.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, user_id, employee_number, full_name, join_date,
            employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01', 'pkwtt', 'active',
                 'v1:opaque', $7, '1990-01-01', 'female', 'single', 'tk_0')`,
        [employeeId, tenantId, companyId, userId, `E-${name}`, name, `bidx-${name}`],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(() => {
    managers = [managerUser];
  });

  function inTenant<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return runInContextScope({}, () => {
      setTenantContext({ tenantId, source: 'jwt' });
      setRequestContext({ requestId: uuidv7(), userId });
      return unitOfWork.run({ tenantId, source: 'jwt' }, fn);
    });
  }

  const singleStep: StepConfig[] = [
    {
      quorum: 'any',
      resolvers: [{ type: 'direct_manager', levels: 1 }],
      onVacancy: { policy: 'fallback_role' },
      onSelfApproval: 'reroute_next_level',
    },
  ];

  async function seedChain(steps: StepConfig[] = singleStep, name = 'Default'): Promise<string> {
    return inTenant(requesterUser, async () => {
      const chain = await chains.create({
        companyId: null,
        requestType: 'leave.request',
        name,
        priority: 100,
        conditions: null,
        steps,
        isActive: true,
      });
      return chain.id;
    });
  }

  async function submit(requestId: string) {
    return inTenant(requesterUser, () =>
      approvals.submit({
        requestType: 'leave.request',
        requestId,
        requesterEmployeeId: requesterEmployee,
        context: { dayCount: 3 },
      }),
    );
  }

  it('submits, activates step 0 and seats the resolved manager', async () => {
    await seedChain();
    const requestId = uuidv7();

    const result = await submit(requestId);
    expect(result.ok).toBe(true);

    const rows = await db.migrator.query(
      `SELECT a.approver_user_id, s.status AS step_status, i.status AS instance_status
         FROM approval_assignees a
         JOIN approval_steps s ON s.id = a.step_id
         JOIN approval_instances i ON i.id = s.instance_id
        WHERE i.request_id = $1`,
      [requestId],
    );
    expect(rows.rows).toEqual([
      { approver_user_id: managerUser, step_status: 'active', instance_status: 'in_progress' },
    ]);
  });

  it('approves through the port and ends the instance with its terminal event', async () => {
    await seedChain();
    const requestId = uuidv7();
    await submit(requestId);

    const decision = await inTenant(managerUser, () =>
      approvals.approve(managerUser, 'leave.request', requestId, 'fine by me'),
    );
    expect(decision.ok && decision.value.instanceStatus).toBe('approved');

    const events = await db.migrator.query(
      'SELECT name FROM domain_events WHERE tenant_id = $1 ORDER BY id',
      [tenantId],
    );
    expect(events.rows.map((row: { name: string }) => row.name)).toEqual(
      expect.arrayContaining(['approval.step.activated', 'approval.instance.approved']),
    );

    const trail = await db.migrator.query(
      `SELECT action FROM approval_actions
        WHERE instance_id = (SELECT id FROM approval_instances WHERE request_id = $1)
        ORDER BY created_at, id`,
      [requestId],
    );
    expect(trail.rows.map((row: { action: string }) => row.action)).toEqual(['submit', 'approve']);
  });

  it('leaves no instance rows when the calling module rolls its transaction back', async () => {
    // §9: "Module submits inside a failing transaction — port call is same-tx —
    // rollback removes instance rows atomically; no orphan instances."
    await seedChain();
    const requestId = uuidv7();

    await expect(
      inTenant(requesterUser, async () => {
        const result = await approvals.submit({
          requestType: 'leave.request',
          requestId,
          requesterEmployeeId: requesterEmployee,
          context: {},
        });
        expect(result.ok).toBe(true);
        throw new Error('module validation failed after submitting');
      }),
    ).rejects.toThrow(/module validation failed/);

    const rows = await db.migrator.query(
      'SELECT id FROM approval_instances WHERE request_id = $1',
      [requestId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('runs the snapshot, not the chain, after the chain is edited', async () => {
    // BR-APRV-004: a config edit reaches new instances only. Proven by editing
    // the chain to a step the running instance must not acquire.
    const chainId = await seedChain();
    const requestId = uuidv7();
    await submit(requestId);

    await inTenant(requesterUser, () =>
      chains.update(chainId, {
        steps: [...singleStep, { ...singleStep[0]!, name: 'Second level' }],
      }),
    );

    const steps = await db.migrator.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_steps
        WHERE instance_id = (SELECT id FROM approval_instances WHERE request_id = $1)`,
      [requestId],
    );
    expect(steps.rows[0]?.n).toBe(1);
  });

  it('decides an `any`-quorum race once, and the loser sees APRV_STEP_ALREADY_DECIDED', async () => {
    await seedChain([{ ...singleStep[0]!, quorum: 'any' }]);
    managers = [managerUser, secondUser];
    const requestId = uuidv7();
    await submit(requestId);

    // Two transactions, both holding the step at version 1. One `UPDATE` matches.
    const [first, second] = await Promise.all([
      inTenant(managerUser, () => approvals.approve(managerUser, 'leave.request', requestId)).catch(
        (error: Error) => error,
      ),
      inTenant(secondUser, () => approvals.approve(secondUser, 'leave.request', requestId)).catch(
        (error: Error) => error,
      ),
    ]);

    const outcomes = [first, second].map((result) =>
      result instanceof Error ? 'threw' : result.ok ? 'approved' : result.error.code,
    );
    // Exactly one decision, and the loser gets a 409 either way. Which of the two
    // it is depends on where READ COMMITTED put its statement snapshots — the
    // step version lost, or the seat was already closed under it — and both are
    // the same fact told from a different line.
    expect(outcomes.filter((outcome) => outcome === 'approved')).toHaveLength(1);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^APRV_(STEP_ALREADY_DECIDED|INSTANCE_NOT_ACTIONABLE)$/),
      ]),
    );

    const instance = await db.migrator.query<{ status: string }>(
      'SELECT status FROM approval_instances WHERE request_id = $1',
      [requestId],
    );
    expect(instance.rows[0]?.status).toBe('approved');
  });

  it('refuses a cancel from anybody but the requester, and cancels for them', async () => {
    await seedChain();
    const requestId = uuidv7();
    await submit(requestId);

    const wrong = await inTenant(managerUser, () =>
      approvals.cancel(managerUser, 'leave.request', requestId),
    );
    expect(!wrong.ok && wrong.error.code).toBe('APRV_NOT_AN_APPROVER');

    const right = await inTenant(requesterUser, () =>
      approvals.cancel(requesterUser, 'leave.request', requestId),
    );
    expect(right.ok).toBe(true);

    const rows = await db.migrator.query(
      `SELECT i.status, s.status AS step_status,
              (SELECT count(*)::int FROM approval_assignees a
                WHERE a.step_id = s.id AND a.status = 'active') AS live_seats
         FROM approval_instances i JOIN approval_steps s ON s.instance_id = i.id
        WHERE i.request_id = $1`,
      [requestId],
    );
    expect(rows.rows[0]).toMatchObject({
      status: 'cancelled',
      step_status: 'skipped',
      live_seats: 0,
    });
  });

  it('writes a channel-1 audit diff when a chain is configured', async () => {
    // The engine's *trail* stays out of the audit log (BR-AUD-004); its
    // *configuration* does not, which is what the §4.2 addition is for.
    const chainId = await seedChain(singleStep, 'Audited chain');

    const rows = await db.migrator.query(
      `SELECT action, entity_type FROM audit_logs
        WHERE entity_id = $1 AND tenant_id = $2`,
      [chainId, tenantId],
    );
    expect(rows.rows).toEqual([
      { action: 'approval_chains.created', entity_type: 'approval_chains' },
    ]);
  });

  it('flags an instance stuck when the ladder runs out, leaving the step active', async () => {
    managers = [];
    await seedChain();
    const requestId = uuidv7();

    await submit(requestId);

    const rows = await db.migrator.query(
      `SELECT i.is_stuck, i.status, s.status AS step_status,
              (SELECT count(*)::int FROM approval_assignees a WHERE a.step_id = s.id) AS seats
         FROM approval_instances i JOIN approval_steps s ON s.instance_id = i.id
        WHERE i.request_id = $1`,
      [requestId],
    );
    expect(rows.rows[0]).toMatchObject({
      is_stuck: true,
      status: 'in_progress',
      step_status: 'active',
      seats: 0,
    });
  });
});
