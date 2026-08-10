import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * `import_jobs` and `export_jobs`' database rules — the assertions no unit test
 * can make.
 *
 * BR-IMP-005's concurrency guard is the sharp one. §9 says *"the partial unique
 * index decides at insert"*, and a fake returning `null` on command proves only
 * that the service reads the fake correctly. The property that matters — two
 * admins uploading the same type in the same second, one of them refused — is a
 * property of a PostgreSQL index, and it is also **partial**, which is the half
 * a plain unique constraint would get wrong by forbidding a second finished
 * import forever.
 */
describe('import-export constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const u1 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'imp-tenant-one'],
      [t2, 'imp-tenant-two'],
    ] as const) {
      await db.app.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [
        tenantId,
        slug,
        slug,
      ]);
    }

    await withTenant(t1, (client) =>
      client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, status)
         VALUES ($1, $2, 'one@example.test', 'x', 'active')`,
        [u1, t1],
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  }, 60_000);

  beforeEach(async () => {
    await db.migrator.query('TRUNCATE import_jobs, export_jobs, files CASCADE');
  });

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

  async function insertFile(client: PoolClient, tenantId: string): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO files
         (id, tenant_id, module, entity_type, entity_id, category, original_name,
          storage_path, mime, size_bytes, sha256, status)
       VALUES ($1, $2, 'import-export', 'user', $3, 'import_file', 'people.xlsx',
               $4, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               1024, 'sha', 'committed')`,
      [id, tenantId, u1, `tenants/${tenantId}/import-export/${id}`],
    );
    return id;
  }

  function insertJob(
    client: PoolClient,
    values: { tenantId: string; type: string; status: string; fileId: string },
  ) {
    return client.query(
      `INSERT INTO import_jobs (id, tenant_id, type, status, file_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), values.tenantId, values.type, values.status, values.fileId],
    );
  }

  describe('BR-IMP-005 — one active import per tenant + type', () => {
    it('refuses a second active import of the same type', async () => {
      await withTenant(t1, async (client) => {
        const fileA = await insertFile(client, t1);
        const fileB = await insertFile(client, t1);
        await insertJob(client, {
          tenantId: t1,
          type: 'employee.master',
          status: 'uploaded',
          fileId: fileA,
        });
        await expect(
          insertJob(client, {
            tenantId: t1,
            type: 'employee.master',
            status: 'validating',
            fileId: fileB,
          }),
        ).rejects.toThrow(/uq_import_jobs_active/);
      });
    });

    it('holds across all four active statuses, not just the first', async () => {
      for (const [held, arriving] of [
        ['uploaded', 'awaiting_confirmation'],
        ['validating', 'committing'],
        ['awaiting_confirmation', 'uploaded'],
        ['committing', 'validating'],
      ] as const) {
        await db.migrator.query('TRUNCATE import_jobs, files CASCADE');
        await withTenant(t1, async (client) => {
          const fileA = await insertFile(client, t1);
          const fileB = await insertFile(client, t1);
          await insertJob(client, {
            tenantId: t1,
            type: 'shift.roster',
            status: held,
            fileId: fileA,
          });
          await expect(
            insertJob(client, {
              tenantId: t1,
              type: 'shift.roster',
              status: arriving,
              fileId: fileB,
            }),
          ).rejects.toThrow(/uq_import_jobs_active/);
        });
      }
    });

    it('lets a second import start once the first reaches any terminal state', async () => {
      for (const terminal of ['completed', 'partially_completed', 'failed', 'cancelled'] as const) {
        await db.migrator.query('TRUNCATE import_jobs, files CASCADE');
        await withTenant(t1, async (client) => {
          const fileA = await insertFile(client, t1);
          const fileB = await insertFile(client, t1);
          await insertJob(client, {
            tenantId: t1,
            type: 'employee.master',
            status: terminal,
            fileId: fileA,
          });
          await insertJob(client, {
            tenantId: t1,
            type: 'employee.master',
            status: 'uploaded',
            fileId: fileB,
          });
        });
      }
    });

    it('accumulates any number of finished imports of one type', async () => {
      await withTenant(t1, async (client) => {
        for (let index = 0; index < 3; index += 1) {
          const fileId = await insertFile(client, t1);
          await insertJob(client, {
            tenantId: t1,
            type: 'employee.master',
            status: 'completed',
            fileId,
          });
        }
        const { rows } = await client.query<{ n: string }>(
          'SELECT count(*)::int AS n FROM import_jobs',
        );
        expect(Number(rows[0]!.n)).toBe(3);
      });
    });

    it('scopes the guard to one type — two different imports run side by side', async () => {
      await withTenant(t1, async (client) => {
        const fileA = await insertFile(client, t1);
        const fileB = await insertFile(client, t1);
        await insertJob(client, {
          tenantId: t1,
          type: 'employee.master',
          status: 'uploaded',
          fileId: fileA,
        });
        await insertJob(client, {
          tenantId: t1,
          type: 'shift.roster',
          status: 'uploaded',
          fileId: fileB,
        });
      });
    });

    it('scopes the guard to one tenant', async () => {
      await withTenant(t1, async (client) => {
        const fileId = await insertFile(client, t1);
        await insertJob(client, {
          tenantId: t1,
          type: 'employee.master',
          status: 'uploaded',
          fileId,
        });
      });
      await withTenant(t2, async (client) => {
        const fileId = await insertFile(client, t2);
        await insertJob(client, {
          tenantId: t2,
          type: 'employee.master',
          status: 'uploaded',
          fileId,
        });
      });

      const { rows } = await db.migrator.query<{ n: string }>(
        "SELECT count(*)::int AS n FROM import_jobs WHERE type = 'employee.master'",
      );
      expect(Number(rows[0]!.n)).toBe(2);
    });

    it('carries the index as a partial one rather than a plain unique', async () => {
      const { rows } = await db.migrator.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_import_jobs_active'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain('UNIQUE');
      expect(rows[0]!.indexdef).toContain('WHERE');
    });
  });

  describe('RLS (ADR-0002) on both tables', () => {
    it('hides another tenant’s import jobs', async () => {
      await withTenant(t1, async (client) => {
        const fileId = await insertFile(client, t1);
        await insertJob(client, {
          tenantId: t1,
          type: 'employee.master',
          status: 'uploaded',
          fileId,
        });
      });

      const visible = await withTenant(t2, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'SELECT count(*)::int AS n FROM import_jobs',
        );
        return Number(rows[0]!.n);
      });
      expect(visible).toBe(0);
    });

    it('hides another tenant’s export jobs', async () => {
      await withTenant(t1, (client) =>
        client.query(
          `INSERT INTO export_jobs (id, tenant_id, type, status, params)
           VALUES ($1, $2, 'employee.master', 'queued', '{}'::jsonb)`,
          [uuidv7(), t1],
        ),
      );

      const visible = await withTenant(t2, async (client) => {
        const { rows } = await client.query<{ n: string }>(
          'SELECT count(*)::int AS n FROM export_jobs',
        );
        return Number(rows[0]!.n);
      });
      expect(visible).toBe(0);
    });

    it('refuses a write stamped with another tenant’s id — the policy’s WITH CHECK half', async () => {
      const fileId = await withTenant(t1, (client) => insertFile(client, t1));

      await withTenant(t2, async (client) => {
        await expect(
          insertJob(client, { tenantId: t1, type: 'employee.master', status: 'uploaded', fileId }),
        ).rejects.toThrow(/row-level security/);
      });

      await withTenant(t2, async (client) => {
        await expect(
          client.query(
            `INSERT INTO export_jobs (id, tenant_id, type, status, params)
             VALUES ($1, $2, 'employee.master', 'queued', '{}'::jsonb)`,
            [uuidv7(), t1],
          ),
        ).rejects.toThrow(/row-level security/);
      });
    });
  });

  it('keeps an export job’s frozen entitlement queryable inside params', async () => {
    // BR-IMP-010's `_gated` flag decides whether a mint is an audited sensitive
    // read, so the resolver reads it back out of jsonb on every download.
    await withTenant(t1, async (client) => {
      await client.query(
        `INSERT INTO export_jobs (id, tenant_id, type, status, params)
         VALUES ($1, $2, 'employee.master', 'completed',
                 '{"companyId":"c1","_columns":["number","nik"],"_gated":true}'::jsonb)`,
        [uuidv7(), t1],
      );
      const { rows } = await client.query<{ gated: boolean; columns: string }>(
        `SELECT (params->>'_gated')::boolean AS gated, params->>'_columns' AS columns
         FROM export_jobs`,
      );
      expect(rows[0]!.gated).toBe(true);
      expect(rows[0]!.columns).toContain('nik');
    });
  });
});
