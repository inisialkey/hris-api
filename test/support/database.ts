import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * A real PostgreSQL with the real migrations applied (coding-standards-nestjs §9).
 * Drizzle is never mocked, and RLS in particular cannot be: the policy is the
 * thing under test, and it does not exist outside a database.
 *
 * Two pools, deliberately. `migrator` owns the objects and carries `BYPASSRLS`;
 * `app` is a non-owner without it. Running the tests as one credential would
 * make every isolation assertion vacuous, which is the same failure
 * environments.md §4 names for connecting as `postgres` on a laptop.
 */
export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  migrator: Pool;
  app: Pool;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('hris')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyFilesToContainer([
      {
        source: 'docker/postgres/init-roles.sql',
        target: '/docker-entrypoint-initdb.d/00-roles.sql',
      },
    ])
    .start();

  const host = container.getHost();
  const port = container.getPort();

  const migrator = new Pool({
    connectionString: `postgres://hris_migrator:hris_migrator@${host}:${port}/hris`,
    max: 1,
  });
  await migrate(drizzle(migrator), { migrationsFolder: 'src/database/migrations' });

  const app = new Pool({
    connectionString: `postgres://hris_app:hris_app@${host}:${port}/hris`,
    max: 4,
  });

  return {
    container,
    migrator,
    app,
    async stop() {
      await app.end();
      await migrator.end();
      await container.stop();
    },
  };
}
