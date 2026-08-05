import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * The `migrate` Job entrypoint (system-overview §3.1: migrations run before
 * application pods; ci-cd §7.1 runs this as an in-cluster Job on the deployed
 * digest, so the pipeline itself holds no database credential).
 *
 * Connects as `hris_migrator` — the object owner, and the only credential in the
 * system carrying `BYPASSRLS`. That bypass is not a convenience: `FORCE` RLS
 * binds the owner too, so without it any in-migration DML on a tenant-class table
 * would silently affect zero rows (database-conventions §9.3).
 *
 * Forward-only. There are no down migrations, and PITR is the real rollback
 * (ADR-0013 rule 7).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL is required');

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: 'src/database/migrations' });
    process.stdout.write('migrations applied\n');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
