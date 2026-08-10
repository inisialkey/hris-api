import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider, type Database } from '../src/database/connection.provider';
import { OutboxRepository } from '../src/database/outbox.repository';
import * as schema from '../src/database/schema';
import { UnitOfWork } from '../src/database/unit-of-work';
import type { ApprovalStepTasks, ApprovalTaskPort } from '../src/modules/approval';
import { AckItemsService } from '../src/modules/inbox/application/ack-items.service';
import { AcknowledgeService } from '../src/modules/inbox/application/acknowledge.service';
import { ApprovalTasksService } from '../src/modules/inbox/application/approval-tasks.service';
import { InboxEventHandlers } from '../src/modules/inbox/application/event-handlers.service';
import { InboxJobsService } from '../src/modules/inbox/application/inbox-jobs.service';
import { InboxListService } from '../src/modules/inbox/application/inbox-list.service';
import { InboxRepository } from '../src/modules/inbox/infrastructure/inbox.repository';
import type { SettingsPort } from '../src/modules/settings';
import { runInContextScope, setRequestContext, setTenantContext } from '../src/shared/context';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * §14's scenario table against a real database.
 *
 * The unit suite proves each decision with fakes that answer on command. What
 * only a database proves is the part the fakes stand in for: that the dedupe is
 * an index rather than a policy, that the closure predicates really do read the
 * jsonb keys materialization wrote, and that the purge deletes what is past the
 * window and *never* an `open` item — which testing-strategy §14.1 requires of
 * every destructive cron two-sided, because a purge with an inverted predicate
 * is perfectly idempotent and destroys everything.
 */
describe('inbox lifecycle', () => {
  const NOW = new Date('2026-03-10T02:00:00Z');

  let db: TestDatabase;
  let unitOfWork: UnitOfWork;
  let items: InboxRepository;
  let tasks: ApprovalTasksService;
  let list: InboxListService;
  let acknowledge: AcknowledgeService;
  let ackItems: AckItemsService;
  let handlers: InboxEventHandlers;
  let jobs: InboxJobsService;

  const tenantId = uuidv7();
  const approverA = uuidv7();
  const approverB = uuidv7();
  const requesterUserId = uuidv7();
  let stepTasks: ApprovalStepTasks | null = null;
  let retentionDays = 180;

  beforeAll(async () => {
    db = await startTestDatabase();
    const drizzleDb: Database = drizzle(db.app, { schema });
    const connection = new ConnectionProvider(drizzleDb);
    unitOfWork = new UnitOfWork(drizzleDb);

    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      tenantId,
      'inb-lifecycle',
    ]);
    // Seeded on one connection with a session-level GUC: `users` is under RLS
    // and `db.app` is a pool where the next statement is a different connection.
    const client = await db.app.connect();
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    for (const [id, email] of [
      [approverA, 'approver-a@example.test'],
      [approverB, 'approver-b@example.test'],
      [requesterUserId, 'requester@example.test'],
    ] as const) {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, $3, 'x', 'active')`,
        [id, tenantId, email],
      );
    }
    client.release();

    const clock = { now: () => NOW };
    const settings = {
      resolve: <T>() => Promise.resolve(retentionDays as T),
    } as unknown as SettingsPort;
    const approvals: ApprovalTaskPort = { stepTasks: () => Promise.resolve(stepTasks) };

    items = new InboxRepository(connection);
    tasks = new ApprovalTasksService(items, approvals);
    list = new InboxListService(items, clock);
    acknowledge = new AcknowledgeService(items, new OutboxRepository(connection, clock), clock);
    ackItems = new AckItemsService(items);
    handlers = new InboxEventHandlers(tasks, clock);
    jobs = new InboxJobsService(items, settings, clock);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    retentionDays = 180;
    stepTasks = step();
    await db.migrator.query('TRUNCATE inbox_items, domain_events CASCADE');
  });

  function step(overrides: Partial<ApprovalStepTasks> = {}): ApprovalStepTasks {
    return {
      instanceId: 'instance-1',
      stepId: 'step-1',
      requestType: 'leave.request',
      requestId: 'request-1',
      requesterUserId,
      requesterName: 'Budi Santoso',
      context: { dayCount: 3 },
      dueAt: new Date('2026-03-11T02:00:00Z'),
      tasks: [
        { assigneeId: 'seat-a', userId: approverA, delegateOfUserId: null, delegateOfName: null },
        { assigneeId: 'seat-b', userId: approverB, delegateOfUserId: null, delegateOfName: null },
      ],
      ...overrides,
    };
  }

  /**
   * One request-shaped unit of work. The tenant is set twice on purpose and it
   * is not redundant: `UnitOfWork.run` sets the database GUC that RLS reads,
   * while `setTenantContext` fills the AsyncLocalStorage the repositories stamp
   * writes from. In production those are two different layers of the guard
   * chain (backend-nestjs §5 positions 3 and 7).
   */
  const asUser = <T>(fn: () => Promise<T>, actor: string): Promise<T> =>
    runInContextScope({}, () => {
      const tenant = { tenantId, source: 'jwt' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7(), userId: actor });
      return unitOfWork.run(tenant, fn);
    });

  /** A worker-shaped one: tenant, no actor — every handler runs like this. */
  const asJob = <T>(fn: () => Promise<T>): Promise<T> =>
    runInContextScope({}, () => {
      const tenant = { tenantId, source: 'job' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7() });
      return unitOfWork.run(tenant, fn);
    });

  const activated = {
    id: 'evt-activated',
    name: 'approval.step.activated',
    aggregateId: 'instance-1',
    payload: { instanceId: 'instance-1', stepId: 'step-1', assigneeUserIds: [approverA] },
  };

  function rowsOf(userId: string) {
    return asUser(() => list.list({ limit: 50, status: 'open' }), userId);
  }

  it('gives every assignee a task and survives a redelivery', async () => {
    // §14: "Step activation ×2 (redelivery) → one item per assignee".
    await asJob(() => handlers.handle(activated));
    const second = await asJob(() => handlers.handle(activated));

    expect(second).toEqual({ affected: 0 });
    expect((await rowsOf(approverA)).rows).toHaveLength(1);
    expect((await rowsOf(approverB)).rows).toHaveLength(1);
  });

  it('renders the title, the deadline and the deep link onto the row', async () => {
    await asJob(() => handlers.handle(activated));

    const [row] = (await rowsOf(approverA)).rows;
    expect(row).toMatchObject({
      type: 'approval_task',
      status: 'open',
      title: 'Pengajuan cuti · Budi Santoso',
      subtitle: '3 hari',
      deepLink: 'leave.request/request-1',
      dueAt: new Date('2026-03-11T02:00:00Z'),
      delegateOf: null,
    });
  });

  it('badges the delegate with the person they act for', async () => {
    // §14: "Delegate item carries delegate badge params; original user has no item".
    stepTasks = step({
      tasks: [
        {
          assigneeId: 'seat-a',
          userId: approverA,
          delegateOfUserId: approverB,
          delegateOfName: 'Sari Wijaya',
        },
      ],
    });
    await asJob(() => handlers.handle(activated));

    expect((await rowsOf(approverA)).rows[0]!.delegateOf).toBe('Sari Wijaya');
    expect((await rowsOf(approverB)).rows).toHaveLength(0);
  });

  it('completes the actor and supersedes the sibling on an any-quorum step', async () => {
    // §14: "`any` quorum: actor `done` via `assignee.acted`, sibling
    // `closed/superseded` on `step.decided`".
    await asJob(() => handlers.handle(activated));

    await asJob(() =>
      handlers.handle({
        id: 'evt-acted',
        name: 'approval.assignee.acted',
        aggregateId: 'instance-1',
        payload: {
          instanceId: 'instance-1',
          stepId: 'step-1',
          assigneeId: 'seat-a',
          actorUserId: approverA,
          action: 'approve',
        },
      }),
    );
    await asJob(() =>
      handlers.handle({
        id: 'evt-decided',
        name: 'approval.step.decided',
        aggregateId: 'instance-1',
        payload: {
          instanceId: 'instance-1',
          stepId: 'step-1',
          outcome: 'approved',
          actorUserId: approverA,
        },
      }),
    );

    const done = await asUser(() => list.list({ limit: 10, status: 'done' }), approverA);
    const closed = await asUser(() => list.list({ limit: 10, status: 'closed' }), approverB);

    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]!.doneAt).toEqual(NOW);
    expect(closed.rows[0]!.closedReason).toBe('superseded');
    // The actor's own item is `done`, not `superseded`: their work happened.
    expect((await rowsOf(approverA)).rows).toHaveLength(0);
  });

  it('leaves an all-quorum non-actor open until the step decides', async () => {
    // §14: "`all` quorum: partial approver `done` immediately, non-actors stay
    // `open` until the step decides".
    await asJob(() => handlers.handle(activated));
    await asJob(() =>
      handlers.handle({
        id: 'evt-acted',
        name: 'approval.assignee.acted',
        aggregateId: 'instance-1',
        payload: {
          instanceId: 'instance-1',
          stepId: 'step-1',
          assigneeId: 'seat-a',
          actorUserId: approverA,
          action: 'approve',
        },
      }),
    );

    expect((await rowsOf(approverA)).rows).toHaveLength(0);
    expect((await rowsOf(approverB)).rows).toHaveLength(1);
  });

  it('closes every remaining item when the instance is cancelled', async () => {
    // §14: "Instance cancelled → all open items `closed/instance_cancelled`".
    await asJob(() => handlers.handle(activated));
    await asJob(() =>
      handlers.handle({
        id: 'evt-cancelled',
        name: 'approval.instance.cancelled',
        aggregateId: 'instance-1',
        payload: {
          instanceId: 'instance-1',
          requestType: 'leave.request',
          requestId: 'request-1',
          requesterUserId,
        },
      }),
    );

    const closed = await asUser(() => list.list({ limit: 10, status: 'closed' }), approverA);
    expect(closed.rows[0]!.closedReason).toBe('instance_cancelled');
    expect(await asUser(() => list.openCount(), approverA)).toBe(0);
  });

  it('counts open items only, and seen-all leaves the count alone', async () => {
    // §14: "Badge counts open only; seen-all leaves count unchanged" —
    // BR-INB-003's *"a task glanced at is still a task"*.
    await asJob(() => handlers.handle(activated));

    expect(await asUser(() => list.openCount(), approverA)).toBe(1);
    expect(await asUser(() => list.markAllSeen(), approverA)).toEqual({ updatedCount: 1 });
    expect(await asUser(() => list.openCount(), approverA)).toBe(1);
    expect((await rowsOf(approverA)).rows[0]!.seenAt).toEqual(NOW);
  });

  it('does not move a seen stamp a second time', async () => {
    await asJob(() => handlers.handle(activated));
    const id = (await rowsOf(approverA)).rows[0]!.id;

    const first = await asUser(() => list.markSeen(id), approverA);
    // A later clock would move it, if the predicate were not `seen_at IS NULL`.
    const second = await asUser(() => list.markSeen(id), approverA);

    expect(first.ok && second.ok && first.value.seenAt).toEqual(
      second.ok ? second.value.seenAt : null,
    );
  });

  it('answers 404 for another user’s item', async () => {
    await asJob(() => handlers.handle(activated));
    const id = (await rowsOf(approverA)).rows[0]!.id;

    const result = await asUser(() => list.markSeen(id), approverB);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SYS_NOT_FOUND');
  });

  it('acknowledges an ack item once and emits the fact', async () => {
    // §14: "Ack: open→done + event; repeat → 200 no-op same `doneAt`".
    await asJob(() =>
      ackItems.createAckItems({
        announcementId: 'announcement-1',
        userIds: [approverA, approverB],
        titleParams: { subject: 'Libur Idulfitri' },
        deepLink: 'announcements/announcement-1',
      }),
    );
    const id = (await rowsOf(approverA)).rows[0]!.id;

    const first = await asUser(() => acknowledge.acknowledge(id), approverA);
    const second = await asUser(() => acknowledge.acknowledge(id), approverA);

    expect(first.ok && second.ok && first.value.doneAt).toEqual(
      second.ok ? second.value.doneAt : null,
    );

    const { rows } = await db.migrator.query<{ name: string; payload: unknown }>(
      'SELECT name, payload FROM domain_events ORDER BY id',
    );
    // One event, not two: announcement's ack rate is a count of people, not taps.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('inbox.item.acknowledged');
    expect(rows[0]!.payload).toMatchObject({
      itemId: id,
      userId: approverA,
      sourceRef: { announcementId: 'announcement-1' },
    });
  });

  it('refuses an acknowledge on an approval task', async () => {
    // §14: "on approval task → 422".
    await asJob(() => handlers.handle(activated));
    const id = (await rowsOf(approverA)).rows[0]!.id;

    const result = await asUser(() => acknowledge.acknowledge(id), approverA);

    expect(result.ok === false && result.error.code).toBe('INB_NOT_ACKNOWLEDGEABLE');
  });

  it('refuses an acknowledge against a retracted announcement', async () => {
    // §14: "on retracted → 409" — §9's offline drain landing after a retraction.
    await asJob(() =>
      ackItems.createAckItems({
        announcementId: 'announcement-1',
        userIds: [approverA],
        titleParams: { subject: 'Libur' },
        deepLink: 'announcements/announcement-1',
      }),
    );
    const id = (await rowsOf(approverA)).rows[0]!.id;

    expect(await asJob(() => ackItems.closeAckItems('announcement-1'))).toBe(1);

    const result = await asUser(() => acknowledge.acknowledge(id), approverA);
    expect(result.ok === false && result.error.code).toBe('INB_ITEM_CLOSED');
    expect(result.ok === false && result.error.details).toEqual({ closedReason: 'retracted' });
  });

  it('leaves an already-acknowledged item alone when the post is retracted', async () => {
    // What keeps announcement's acknowledgment rate reproducible after a
    // retraction: a `done` item is somebody's recorded acknowledgment.
    await asJob(() =>
      ackItems.createAckItems({
        announcementId: 'announcement-1',
        userIds: [approverA, approverB],
        titleParams: { subject: 'Libur' },
        deepLink: 'd',
      }),
    );
    const id = (await rowsOf(approverA)).rows[0]!.id;
    await asUser(() => acknowledge.acknowledge(id), approverA);

    expect(await asJob(() => ackItems.closeAckItems('announcement-1'))).toBe(1);

    const done = await asUser(() => list.list({ limit: 10, status: 'done' }), approverA);
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]!.closedReason).toBeNull();
  });

  it('purges closed items past the window and never an open one', async () => {
    // §14: "Purge removes done/closed past retention, never open". Two-sided per
    // testing-strategy §14.1 — an inverted predicate is perfectly idempotent.
    await asJob(() => handlers.handle(activated));
    await asJob(() =>
      handlers.handle({
        id: 'evt-acted',
        name: 'approval.assignee.acted',
        aggregateId: 'instance-1',
        payload: {
          instanceId: 'instance-1',
          stepId: 'step-1',
          assigneeId: 'seat-a',
          actorUserId: approverA,
          action: 'approve',
        },
      }),
    );

    // Age everything past the window. The `open` item is older than the `done`
    // one, so a predicate that forgot the status filter would take it first.
    await db.migrator.query("UPDATE inbox_items SET created_at = now() - interval '400 days'");

    expect(await asJob(() => jobs.purge())).toEqual({ purged: 1 });

    const { rows } = await db.migrator.query<{ status: string }>('SELECT status FROM inbox_items');
    expect(rows.map((row) => row.status)).toEqual(['open']);
  });

  it('keeps a recently closed item until its window passes', async () => {
    await asJob(() => handlers.handle(activated));
    await asJob(() =>
      handlers.handle({
        id: 'evt-cancelled',
        name: 'approval.instance.cancelled',
        aggregateId: 'instance-1',
        payload: { instanceId: 'instance-1', requesterUserId },
      }),
    );

    expect(await asJob(() => jobs.purge())).toEqual({ purged: 0 });
  });

  it('pages the list newest first with a stable cursor', async () => {
    stepTasks = step({
      tasks: [
        { assigneeId: 'seat-1', userId: approverA, delegateOfUserId: null, delegateOfName: null },
      ],
    });
    await asJob(() => handlers.handle(activated));
    stepTasks = step({
      stepId: 'step-2',
      tasks: [
        { assigneeId: 'seat-2', userId: approverA, delegateOfUserId: null, delegateOfName: null },
      ],
    });
    await asJob(() => handlers.handle({ ...activated, payload: { stepId: 'step-2' } }));

    const first = await asUser(() => list.list({ limit: 1, status: 'open' }), approverA);
    expect(first.hasMore).toBe(true);

    const second = await asUser(
      () =>
        list.list({
          limit: 1,
          status: 'open',
          after: { createdAt: first.rows[0]!.createdAt, id: first.rows[0]!.id },
        }),
      approverA,
    );

    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
    expect(second.hasMore).toBe(false);
  });

  it('filters by type', async () => {
    await asJob(() => handlers.handle(activated));
    await asJob(() =>
      ackItems.createAckItems({
        announcementId: 'announcement-1',
        userIds: [approverA],
        titleParams: { subject: 'Libur' },
        deepLink: 'd',
      }),
    );

    const acks = await asUser(
      () => list.list({ limit: 10, status: 'open', type: 'acknowledgment' }),
      approverA,
    );
    expect(acks.rows).toHaveLength(1);
    expect(acks.rows[0]!.title).toBe('Perlu konfirmasi baca · Libur');
  });

  it('keeps one tenant’s items out of another’s reach', async () => {
    // ADR-0002 layer 2, through the repository rather than raw SQL: the same
    // read from a different tenant context returns nothing.
    await asJob(() => handlers.handle(activated));

    const otherTenant = uuidv7();
    await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)', [
      otherTenant,
      'inb-other',
    ]);

    const visible = await runInContextScope({}, () => {
      const tenant = { tenantId: otherTenant, source: 'jwt' as const };
      setTenantContext(tenant);
      setRequestContext({ requestId: uuidv7(), userId: approverA });
      return unitOfWork.run(tenant, () => list.openCount());
    });

    expect(visible).toBe(0);
  });

  it('reports what the ack fan-out actually wrote on a retry', async () => {
    const command = {
      announcementId: 'announcement-1',
      userIds: [approverA, approverB],
      titleParams: { subject: 'Libur' },
      deepLink: 'd',
    };

    expect(await asJob(() => ackItems.createAckItems(command))).toEqual({
      created: 2,
      deduped: 0,
    });
    // UC-ANN-005's *"a retry converges rather than duplicating"*.
    expect(await asJob(() => ackItems.createAckItems(command))).toEqual({
      created: 0,
      deduped: 2,
    });
  });

  it('ignores an unrelated event', async () => {
    expect(
      await asJob(() =>
        handlers.handle({
          id: 'evt-x',
          name: 'payroll.run.completed',
          aggregateId: 'run-1',
          payload: {},
        }),
      ),
    ).toBeNull();
  });
});
