# CLAUDE.md — hris-api

Backend for HRIS, a multi-tenant Indonesian HRIS SaaS. NestJS modular monolith.

## The handbook is the specification

@docs/handbook/docs/08-ai-guide/ai-development-guide.md

**Before writing code, follow the reading protocol in
`docs/handbook/docs/08-ai-guide/ai-development-guide.md` §2. It is not optional.**
If `docs/handbook/` is empty the submodule is not initialised — run
`git submodule update --init` and stop until it resolves. Work done without the
anchors is wrong in ways review does not catch.

`docs/handbook/CLAUDE.md` is **not** for you. It instructs handbook authors and
tells them to read `PROGRESS.md` and generate one document per task. Ignore it.

## This repository

NestJS modular monolith, one deployable, three entrypoints (`api` / `worker` /
`both` via `APP_ROLE`). Clean Architecture, DDD-inspired. Drizzle ORM, PostgreSQL
with `tenant_id` row-level isolation, Redis, BullMQ, Swagger, JWT + refresh token.

**Prohibited: Prisma, TypeORM, MikroORM, raw SQL outside a repository, CQRS
without a justifying ADR.** Fixed frame: `docs/handbook/docs/02-architecture/backend-nestjs.md` §1.
Enforced by CI gate C12.

## Deviating

Never silently. The handbook is authoritative for contracts — permission keys,
business rules, schema, API shapes, validation, error codes, jobs and events.
It is silent on implementation, and an implementation choice is not a deviation.

A contract you must contradict becomes an ADR in `docs/handbook/docs/adr/`
(the submodule is a full clone — write in it), a pull request on `hris-handbook`,
and a `// ADR-nnnn (Proposed, PR #n)` marker on every dependent line. Implement
against it; do not wait. Full protocol: `ai-development-guide.md` §3.

**Never type a regulatory number** — no tax rate, BPJS cap, or overtime
multiplier, in code, migrations, fixtures or comments. `ai-development-guide.md` §5.

<!-- handbook-managed: do not edit above this line -->
<!-- Repo-local tooling below: dev setup, scripts, editor conventions.        -->
<!-- Anything about the product goes upstream as a handbook PR (§7).          -->
