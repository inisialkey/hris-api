CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"key" text NOT NULL,
	"current_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_number" text NOT NULL,
	"full_name" text NOT NULL,
	"join_date" date NOT NULL,
	"employment_type" "employment_type" NOT NULL,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counters" ADD CONSTRAINT "counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_companies_tenant_id_code" ON "companies" USING btree ("tenant_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_counters_scope" ON "counters" USING btree ("tenant_id","company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employees_tenant_id_company_id_number" ON "employees" USING btree ("tenant_id","company_id","employee_number") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employees_tenant_id_user_id" ON "employees" USING btree ("tenant_id","user_id") WHERE user_id IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_employees_tenant_id_company_id_status" ON "employees" USING btree ("tenant_id","company_id","status");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4).
-- It ships in the migration that creates these tables rather than in a later
-- one: a separate "add policies" migration leaves a window in which the table
-- exists unguarded, and an ordering coupling drizzle-kit cannot see (rule 8).
--
-- The statement-breakpoint markers are load-bearing. The migrator runs each
-- chunk through the extended query protocol, which accepts exactly one statement.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- NULLIF is load-bearing, and database-conventions §9.2's template omits it.
-- `set_config(..., true)` is transaction-local, so at commit the GUC reverts to
-- its *reset value* — which is the empty string, not NULL, for every connection
-- that has ever carried a tenant. `''::uuid` then raises
-- `invalid input syntax for type uuid` instead of yielding NULL, so on a pooled
-- connection the second and every later request that forgets `set_config`
-- errors rather than reading zero rows. Still fail-closed, and still not what
-- ADR-0002, database-conventions §9.2 and multi-tenancy §5's L2 all promise.
-- Found by running it (implementation-roadmap §4.1). Handbook PR pending.
CREATE POLICY tenant_isolation ON companies
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON employees
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON counters
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- NULLS NOT DISTINCT: a tenant-level counter carries company_id NULL, and under
-- the default two such rows for the same key are both legal — a duplicate
-- counter, and therefore a duplicate employee number. Drizzle cannot express it,
-- which is why core-schema pins PostgreSQL 16 (A-010).
DROP INDEX "uq_counters_scope";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_counters_scope" ON "counters"
  USING btree ("tenant_id","company_id","key") NULLS NOT DISTINCT;
