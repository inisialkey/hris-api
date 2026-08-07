import type { PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * document-storage §14's database rows — the assertions no unit test can make.
 *
 * A magic-byte sniff is a pure function and a category policy is a map, but
 * *nothing stops a committed row from carrying no digest* except the CHECK,
 * nothing closes `employee_contracts.file_id`'s two-migration deferral except the
 * foreign key, and RLS is not a property of a repository.
 */
describe('document storage constraints', () => {
  let db: TestDatabase;
  const t1 = uuidv7();
  const t2 = uuidv7();
  const c1 = uuidv7();
  const c2 = uuidv7();
  const u1 = uuidv7();
  const e1 = uuidv7();
  const e2 = uuidv7();

  beforeAll(async () => {
    db = await startTestDatabase();

    for (const [tenantId, slug] of [
      [t1, 'doc-tenant-one'],
      [t2, 'doc-tenant-two'],
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
         VALUES ($1, $2, 'owner@example.test', 'x', 'active')`,
        [u1, t1],
      );
      await client.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, user_id, employee_number, full_name, join_date,
            employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, $4, 'E-0001', 'Subject', '2026-01-01', 'pkwtt', 'active',
                 'v1:opaque', 'doc-bidx-1', '1990-01-01', 'female', 'single', 'tk_0')`,
        [e1, t1, c1, u1],
      );
    });

    await withTenant(t2, async (client) => {
      await client.query(
        'INSERT INTO companies (id, tenant_id, code, name) VALUES ($1, $2, $3, $4)',
        [c2, t2, 'C1', 'Other Tenant Company'],
      );
      await client.query(
        `INSERT INTO employees
           (id, tenant_id, company_id, employee_number, full_name, join_date,
            employment_type, status, nik, nik_bidx, birth_date, gender, marital_status, ptkp_status)
         VALUES ($1, $2, $3, 'E-0001', 'Other', '2026-01-01', 'pkwtt', 'active',
                 'v1:opaque', 'doc-bidx-2', '1990-01-01', 'female', 'single', 'tk_0')`,
        [e2, t2, c2],
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

  function insertFile(
    client: PoolClient,
    over: {
      id?: string;
      tenantId?: string;
      entityId?: string;
      status?: string;
      sha256?: string | null;
      sizeBytes?: number;
      category?: string;
      documentExpiresAt?: string | null;
    } = {},
  ) {
    const id = over.id ?? uuidv7();
    const tenantId = over.tenantId ?? t1;
    return client.query(
      `INSERT INTO files
         (id, tenant_id, module, entity_type, entity_id, category, original_name,
          storage_path, mime, size_bytes, sha256, status, document_expires_at)
       VALUES ($1, $2, 'employee', 'employee', $3, $4, 'ktp.png',
               $5, 'image/png', $6, $7, $8, $9)`,
      [
        id,
        tenantId,
        over.entityId ?? e1,
        over.category ?? 'employee_document',
        `tenants/${tenantId}/employee/${over.entityId ?? e1}/${id}_ktp.png`,
        over.sizeBytes ?? 1024,
        over.sha256 === undefined ? 'a'.repeat(64) : over.sha256,
        over.status ?? 'committed',
        over.documentExpiresAt ?? null,
      ],
    );
  }

  it('refuses a committed row with no digest', async () => {
    // BR-DOC-004: a committed file is one whose bytes were verified, and a row
    // wearing that status without a digest is a claim nobody checked.
    await expect(withTenant(t1, (client) => insertFile(client, { sha256: null }))).rejects.toThrow(
      /ck_files_sha256_when_committed/,
    );
  });

  it('lets a staged row have no digest, because it has no verified bytes yet', async () => {
    await expect(
      withTenant(t1, (client) => insertFile(client, { status: 'staged', sha256: null })),
    ).resolves.toBeDefined();
  });

  it('refuses a zero-byte row from any writer', async () => {
    // §8's "int ≥ 1". The validator states it for the field entry; the CHECK
    // states it for the worker path and every future import.
    await expect(withTenant(t1, (client) => insertFile(client, { sizeBytes: 0 }))).rejects.toThrow(
      /ck_files_size_bytes/,
    );
  });

  it('closes the `employee_contracts.file_id` deferral with a real foreign key', async () => {
    const stranger = uuidv7();
    await expect(
      withTenant(t1, (client) =>
        client.query(
          `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, file_id)
           VALUES ($1, $2, $3, 'pkwtt', '2026-01-01', $4)`,
          [uuidv7(), t1, e1, stranger],
        ),
      ),
    ).rejects.toThrow(/employee_contracts_file_id_files_id_fk/);
  });

  it('accepts a contract pointing at a file that exists', async () => {
    const fileId = uuidv7();
    await withTenant(t1, async (client) => {
      await insertFile(client, { id: fileId });
      await client.query(
        `INSERT INTO employee_contracts (id, tenant_id, employee_id, kind, start_date, file_id)
         VALUES ($1, $2, $3, 'pkwtt', '2027-01-01', $4)`,
        [uuidv7(), t1, e1, fileId],
      );
    });

    const bound = await withTenant(t1, (client) =>
      client.query('SELECT file_id FROM employee_contracts WHERE file_id = $1', [fileId]),
    );
    expect(bound.rowCount).toBe(1);
  });

  it('hides one tenant’s files from another', async () => {
    // RLS is not a property of a repository: this reads the table directly, as
    // `hris_app`, with the other tenant's GUC set.
    const mine = uuidv7();
    await withTenant(t1, (client) => insertFile(client, { id: mine }));

    const seen = await withTenant(t2, (client) =>
      client.query('SELECT id FROM files WHERE id = $1', [mine]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it('refuses to write a row into a tenant the context is not in', async () => {
    // The policy's `WITH CHECK` half — the one an `INSERT … VALUES (other_tenant)`
    // would otherwise walk straight through.
    await expect(
      withTenant(t2, (client) => insertFile(client, { tenantId: t1, entityId: e2 })),
    ).rejects.toThrow(/row-level security/);
  });

  it('builds the three scan indexes §4.1 declares, each with its partial predicate', async () => {
    // The predicate is the assertion, not the plan: which index the planner picks
    // on a table of four rows is a fact about statistics, while `WHERE status =
    // 'staged'` is what stops an hourly sweep paging through every file a tenant
    // has ever kept, whatever the planner is feeling.
    const indexes = await db.app.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'files' ORDER BY indexname`,
    );
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));

    expect(byName.get('idx_files_entity')).toContain('WHERE (deleted_at IS NULL)');
    expect(byName.get('idx_files_expiry_scan')).toContain("status = 'committed'");
    expect(byName.get('idx_files_expiry_scan')).toContain('document_expires_at IS NOT NULL');
    expect(byName.get('idx_files_staged_sweep')).toContain("WHERE (status = 'staged'");
  });
});
