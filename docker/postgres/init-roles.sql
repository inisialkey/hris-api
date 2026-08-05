-- Database roles (multi-tenancy §4). Created once per environment, before the
-- first migration. Locally this runs from the postgres image's init hook; in
-- staging and production it is the bootstrap script of environments.md §5.
--
-- Why the application must not connect as `postgres`: `postgres` owns the
-- objects, and database-conventions §9.3 is explicit that FORCE RLS binds the
-- owner too. Connect as the owner and every tenant-isolation defect is invisible
-- on a laptop and first appears in CI — or in production. The local database is
-- not permissive (environments.md §4).

CREATE ROLE hris_migrator LOGIN PASSWORD 'hris_migrator' BYPASSRLS;
-- BYPASSRLS is deliberate and CI-only. FORCE RLS binds the owner, so without it
-- in-migration DML on tenant-class rows silently affects zero rows.

CREATE ROLE hris_app LOGIN PASSWORD 'hris_app' NOBYPASSRLS;
-- Runtime. Never the owner, never a bypass — that pairing is the second lock.

CREATE ROLE hris_auth NOLOGIN NOBYPASSRLS;
-- Pre-tenant auth lookups, assumed via SET LOCAL ROLE inside the lookup
-- transaction (authentication.md §4). Transaction-scoped, so pooling-safe.
GRANT hris_auth TO hris_app;

\connect hris

-- The migrator owns the schema and needs CREATE on the database: drizzle keeps
-- its applied-migrations journal in a `drizzle` schema it creates on first run.
GRANT CREATE, CONNECT ON DATABASE hris TO hris_migrator;
GRANT CONNECT ON DATABASE hris TO hris_app;

ALTER SCHEMA public OWNER TO hris_migrator;
GRANT USAGE ON SCHEMA public TO hris_app;
GRANT USAGE ON SCHEMA public TO hris_auth;

ALTER DEFAULT PRIVILEGES FOR ROLE hris_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hris_app;
-- No CREATE, no TRUNCATE, no DDL for hris_app. No sequences exist: PKs are
-- application-generated UUIDv7 (database-conventions §1.2).
--
-- hris_auth gets no default privileges. Every one of its grants is written by
-- hand in the migration that creates the table it reads, so the role's reach is
-- enumerable by grepping for its name (leak test L7).
