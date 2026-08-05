# hris-api

Backend for HRIS, a multi-tenant Indonesian HRIS SaaS. NestJS modular monolith.

**The handbook is the specification.** It is mounted at `docs/handbook/` as a
pinned submodule. Read `CLAUDE.md` before writing code — including the reading
protocol it points at, which is not optional.

This file is repo-local tooling only: how to run the thing on a laptop.

## Prerequisites

- **Node 22** and **Docker**. Nothing else.
- Clone with submodules, or the handbook directory is empty and every anchor is
  missing: `git clone --recurse-submodules`, or `git submodule update --init`
  after the fact.

### One conflict worth knowing about

Compose publishes PostgreSQL and Redis on **`127.0.0.1`** rather than `0.0.0.0`,
deliberately. If you already run Redis or PostgreSQL locally — a Homebrew
service, say — `docker compose up` will fail with *address already in use*.

That failure is the feature. Published on `0.0.0.0`, both would coexist with a
host service, the application would connect to whichever answered loopback, and
everything would appear to work **against the wrong store**. That happened once
here; the only symptom was an empty `KEYS` inside the container (A-186).

```bash
brew services stop redis        # or postgresql, or whatever holds the port
```

## First run

```bash
npm install
docker compose up -d                       # PostgreSQL 16 + Redis 7
cp .env.example .env
node scripts/generate-jwt-key.mjs           # paste the three lines into .env
npm run migrate                             # schema + RLS policies
npm run seed:dev                            # two tenants
npm run start:dev
```

The JWT step mints an Ed25519 pair (A-014) for local use only. In staging and
production the pair lives in Secret Manager and rotates every 90 days; this
script exists so a laptop needs none of that machinery, and so nobody is tempted
to commit a key "just for dev".

Then: `http://localhost:3000/api/docs`.

## What the seed gives you

**Two** tenants, not one. Cross-tenant behaviour has to be visible while you are
developing, not only while tests run — a single-tenant local database makes
every isolation defect look like correct behaviour.

| | |
|---|---|
| `admin@tenant-one.test` | `skeleton-password-1` |
| `admin@tenant-two.test` | `skeleton-password-1` |

```bash
BASE=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@tenant-one.test","password":"skeleton-password-1"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["accessToken"])')

curl -s $BASE/auth/me            -H "authorization: Bearer $TOKEN"
curl -s $BASE/scratch-notes      -H "authorization: Bearer $TOKEN"
```

Log in as the *other* tenant and the same `GET /scratch-notes` returns different
rows — from a query with **no tenant predicate in it at all**. That is RLS, and
the omission is the point.

**`scratch-notes` is temporary.** It is the walking skeleton's throwaway probe
(`implementation-roadmap.md` §4.1) and is deleted with the module that replaces
it. Do not build on it.

The application connects as **`hris_app`** — a non-owner without `BYPASSRLS`.
Never point `DATABASE_URL` at `postgres`: that role owns the objects, `FORCE`
RLS does not bind an owner, and every tenant-isolation defect becomes invisible
here and first appears in CI or in production.

## Testing

```bash
npm test                  # unit — no database, no network
npm run test:integration  # Testcontainers: real PostgreSQL, real migrations
```

Integration tests bring their own PostgreSQL on a random port, so they do not
touch your Compose stack and do not care whether it is running. They do need
Docker.

## Running what CI runs

The gate job is not a black box — every step is a script you can run:

```bash
npm run typecheck
npm run lint
npm run format
npm run lint:routes            # ADR-0005: every route declares its permission
node scripts/handbook-check.mjs  # C12 banned deps, C13 handbook-managed regions
npm run db:check               # C7: schema ↔ migration drift
```

`lint:routes` is worth understanding rather than just passing. A route carrying
no `@RequirePermission`, `@Public()` or `@AuthenticatedOnly()` is a **build
failure**, not a silent pass — that is what makes deny-by-default structural
instead of conventional.

## After changing the schema

```bash
npm run db:generate -- --name create_something
```

Then **open the generated SQL and hand-add the `-- manual:` block**: the RLS
policy for any tenant-class table, plus any EXCLUDE constraint or
`NULLS NOT DISTINCT` rewrite drizzle-kit cannot express. It ships in the
migration that creates the table, never in a later one — a separate
"add policies" migration leaves a window in which the table exists unguarded
(database-conventions §10 rules 4 and 8).

Copy the shape from `0002_create_identity_tables.sql`. Migrations are
forward-only and immutable once applied.

## Not local yet, and why

| | Arrives with |
|---|---|
| `fake-gcs-server` | document-storage — a container nothing connects to teaches nobody anything |
| Mailpit | notification, for the same reason |
| FCM | never emulated: no emulator exists, which is why environments.md §4 keeps one real `hris-dev` Firebase project |
| `admin-web`, mobile | their own repositories, and deliberately not containerised |

Full local topology: `docs/handbook/docs/07-operations/environments.md` §4.
