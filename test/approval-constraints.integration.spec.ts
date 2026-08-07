import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * approval-engine §14's database rows — the assertions no unit test can make.
 *
 * `quorum.ts` decides an outcome, but *nothing stops two live instances for one
 * request* except the partial unique index, nothing stops an approval decision
 * being edited afterwards except the revoked grant, and RLS is not a property of
 * a repository.
 */
describe('approval constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();
  const c2 = uuidv7();
  const u1 = uuidv7();
  const e1 = uuidv7();
  const u2 = uuidv7();
  const e2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'aprv-tenant-one'],
      [t2, 'aprv-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await withTenant(t1, async (client) => {
      await client.query(
        'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [c1, t1, 'C1', 'Company One'],
      );
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'requester@example.test', 'x', 'active')`,
        [u1, t1],
      );
      await client.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, user_id, employee_number, full_name, join_date,
            employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, $4, 'E-0001', 'Requester', '2026-01-01', 'pkwtt', 'active',
                 'v1:opaque', 'bidx-1', '1990-01-01', 'female', 'single', 'tk_0')`,
        [e1, t1, c1, u1],
      );
    });

    await withTenant(t2, async (client) => {
      await client.query(
        'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [c2, t2, 'C1', 'Other Tenant Company'],
      );
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'other@example.test', 'x', 'active')`,
        [u2, t2],
      );
      await client.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, user_id, employee_number, full_name, join_date,
            employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, $4, 'E-0001', 'Other', '2026-01-01', 'pkwtt', 'active',
                 'v1:opaque', 'bidx-2', '1990-01-01', 'female', 'single', 'tk_0')`,
        [e2, t2, c2, u2],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  async function withTenant<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function insertInstance(
    client: PoolClient,
    over: { id?: string; requestId?: string; status?: string } = {},
  ) {
    return client.query(
      `INSERT INTO approval_instances
         (id, tenant_id, company_id, request_type, request_id, requester_employee_id,
          requester_user_id, status, chain_snapshot, context)
       VALUES ($1, $2, $3, 'leave.request', $4, $5, $6, $7, '{}'::jsonb, '{}'::jsonb)`,
      [
        over.id ?? uuidv7(),
        t1,
        c1,
        over.requestId ?? uuidv7(),
        e1,
        u1,
        over.status ?? 'in_progress',
      ],
    );
  }

  describe('one live instance per request (BR-APRV-005)', () => {
    it('refuses a second in-progress instance for the same request', async () => {
      const requestId = uuidv7();
      await withTenant(t1, (client) => insertInstance(client, { requestId }));

      await expect(
        withTenant(t1, (client) => insertInstance(client, { requestId })),
      ).rejects.toThrow(/uq_approval_instances_live/);
    });

    it('allows a resubmission once the previous instance is terminal', async () => {
      // UC-APRV-004: the returned instance stays, the new one runs, and both
      // reference the same request id — which is what makes the index partial.
      const requestId = uuidv7();
      await withTenant(t1, (client) => insertInstance(client, { requestId, status: 'returned' }));

      await expect(
        withTenant(t1, (client) => insertInstance(client, { requestId })),
      ).resolves.toBeDefined();
    });

    it('scopes the uniqueness to one tenant', async () => {
      const requestId = uuidv7();
      await withTenant(t1, (client) => insertInstance(client, { requestId }));

      // Same request id, other tenant, that tenant's own people: a different row
      // entirely, and the index says so because `tenant_id` leads it.
      await expect(
        withTenant(t2, (client) =>
          client.query(
            `INSERT INTO approval_instances
               (id, tenant_id, company_id, request_type, request_id, requester_employee_id,
                requester_user_id, status, chain_snapshot, context)
             VALUES ($1, $2, $3, 'leave.request', $4, $5, $6, 'in_progress', '{}'::jsonb, '{}'::jsonb)`,
            [uuidv7(), t2, c2, requestId, e2, u2],
          ),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('append-only trail (BR-APRV-015)', () => {
    it('refuses UPDATE and DELETE as the application role', async () => {
      const instanceId = uuidv7();
      const actionId = uuidv7();
      await withTenant(t1, async (client) => {
        await insertInstance(client, { id: instanceId });
        await client.query(
          `INSERT INTO approval_actions (id, tenant_id, instance_id, actor_user_id, action)
           VALUES ($1, $2, $3, $4, 'submit')`,
          [actionId, t1, instanceId, u1],
        );
      });

      await expect(
        withTenant(t1, (client) =>
          client.query('UPDATE approval_actions SET comment = $1 WHERE id = $2', [
            'edited',
            actionId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);

      await expect(
        withTenant(t1, (client) =>
          client.query('DELETE FROM approval_actions WHERE id = $1', [actionId]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('step and delegation CHECKs (§8)', () => {
    it('refuses an SLA under one hour', async () => {
      const instanceId = uuidv7();
      await withTenant(t1, (client) => insertInstance(client, { id: instanceId }));

      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO approval_steps (id, tenant_id, instance_id, step_index, quorum, sla_hours)
             VALUES ($1, $2, $3, 0, 'any', 0)`,
            [uuidv7(), t1, instanceId],
          ),
        ),
      ).rejects.toThrow(/ck_approval_steps_sla_hours/);
    });

    it('refuses an inverted delegation range', async () => {
      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO approval_delegations
               (id, tenant_id, delegator_user_id, delegate_user_id, start_date, end_date)
             VALUES ($1, $2, $3, $3, '2026-03-31', '2026-03-01')`,
            [uuidv7(), t1, u1],
          ),
        ),
      ).rejects.toThrow(/ck_approval_delegations_range/);
    });
  });

  describe('one seat per user per step (BR-APRV-009)', () => {
    it('refuses two assignee rows for one user on one step', async () => {
      const instanceId = uuidv7();
      const stepId = uuidv7();
      await withTenant(t1, async (client) => {
        await insertInstance(client, { id: instanceId });
        await client.query(
          `INSERT INTO approval_steps (id, tenant_id, instance_id, step_index, quorum)
           VALUES ($1, $2, $3, 0, 'any')`,
          [stepId, t1, instanceId],
        );
        await client.query(
          `INSERT INTO approval_assignees (id, tenant_id, step_id, approver_user_id)
           VALUES ($1, $2, $3, $4)`,
          [uuidv7(), t1, stepId, u1],
        );
      });

      // Two delegators redirecting to one person is the shape that produces this.
      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO approval_assignees (id, tenant_id, step_id, approver_user_id)
             VALUES ($1, $2, $3, $4)`,
            [uuidv7(), t1, stepId, u1],
          ),
        ),
      ).rejects.toThrow(/uq_approval_assignees_step_user/);
    });

    it('cascades steps and assignees when an instance is deleted', async () => {
      const instanceId = uuidv7();
      const stepId = uuidv7();
      await withTenant(t1, async (client) => {
        await insertInstance(client, { id: instanceId });
        await client.query(
          `INSERT INTO approval_steps (id, tenant_id, instance_id, step_index, quorum)
           VALUES ($1, $2, $3, 0, 'any')`,
          [stepId, t1, instanceId],
        );
        await client.query(
          `INSERT INTO approval_assignees (id, tenant_id, step_id, approver_user_id)
           VALUES ($1, $2, $3, $4)`,
          [uuidv7(), t1, stepId, u1],
        );
      });

      // The migrator owns the rows, so it is the credential that can remove the
      // parent — `approval_actions` has no cascade on purpose (it is the trail).
      await db.migrator.query('DELETE FROM approval_actions WHERE instance_id = $1', [instanceId]);
      await db.migrator.query('DELETE FROM approval_instances WHERE id = $1', [instanceId]);

      const steps = await db.migrator.query(
        'SELECT id FROM approval_steps WHERE instance_id = $1',
        [instanceId],
      );
      const assignees = await db.migrator.query(
        'SELECT id FROM approval_assignees WHERE step_id = $1',
        [stepId],
      );
      expect(steps.rowCount).toBe(0);
      expect(assignees.rowCount).toBe(0);
    });
  });

  describe('row-level security (ADR-0002)', () => {
    it('hides every approval table across tenants', async () => {
      const instanceId = uuidv7();
      const chainId = uuidv7();
      const delegationId = uuidv7();
      const actionId = uuidv7();
      await withTenant(t1, async (client) => {
        await insertInstance(client, { id: instanceId });
        await client.query(
          `INSERT INTO approval_chains (id, tenant_id, company_id, request_type, name, steps)
           VALUES ($1, $2, $3, 'leave.request', 'Default', '[]'::jsonb)`,
          [chainId, t1, c1],
        );
        await client.query(
          `INSERT INTO approval_delegations
             (id, tenant_id, delegator_user_id, delegate_user_id, start_date, end_date)
           VALUES ($1, $2, $3, $3, '2026-03-01', '2026-03-31')`,
          [delegationId, t1, u1],
        );
        await client.query(
          `INSERT INTO approval_actions (id, tenant_id, instance_id, actor_user_id, action)
           VALUES ($1, $2, $3, $4, 'submit')`,
          [actionId, t1, instanceId, u1],
        );
      });

      // By id rather than by count: the other tenant owns rows of its own from
      // the tests above, and "cannot see *these*" is the property under test.
      const visible = await withTenant(t2, async (client) => ({
        instances: (
          await client.query('SELECT id FROM approval_instances WHERE id = $1', [instanceId])
        ).rowCount,
        chains: (await client.query('SELECT id FROM approval_chains WHERE id = $1', [chainId]))
          .rowCount,
        delegations: (
          await client.query('SELECT id FROM approval_delegations WHERE id = $1', [delegationId])
        ).rowCount,
        actions: (await client.query('SELECT id FROM approval_actions WHERE id = $1', [actionId]))
          .rowCount,
      }));

      expect(visible).toEqual({ instances: 0, chains: 0, delegations: 0, actions: 0 });
    });

    it('refuses a write that claims another tenant', async () => {
      await expect(
        withTenant(t1, (client) =>
          client.query(
            `INSERT INTO approval_chains (id, tenant_id, company_id, request_type, name, steps)
             VALUES ($1, $2, NULL, 'leave.request', 'Smuggled', '[]'::jsonb)`,
            [uuidv7(), t2],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});
