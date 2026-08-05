CREATE TABLE "role_permissions" (
	"tenant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_role_permissions_tenant_id_role_id" ON "role_permissions" USING btree ("tenant_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_roles_tenant_id_key" ON "roles" USING btree ("tenant_id","key") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_roles_assignment" ON "user_roles" USING btree ("tenant_id","user_id","role_id","company_id");--> statement-breakpoint
CREATE INDEX "idx_user_roles_tenant_id_user_id" ON "user_roles" USING btree ("tenant_id","user_id");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4).
-- It ships in the migration that creates these tables rather than in a later
-- one: a separate "add policies" migration leaves a window in which the table
-- exists unguarded, and an ordering coupling drizzle-kit cannot see (rule 8).
--
-- The statement-breakpoint markers are load-bearing. The migrator runs each
-- chunk through the extended query protocol, which accepts exactly one statement.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
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
CREATE POLICY tenant_isolation ON roles
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_permissions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON user_roles
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- NULLS NOT DISTINCT: company_id NULL means a tenant-wide assignment (ADR-0005).
-- Under the default, one user could hold the same role tenant-wide twice.
DROP INDEX "uq_user_roles_assignment";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_roles_assignment" ON "user_roles"
  USING btree ("tenant_id","user_id","role_id","company_id") NULLS NOT DISTINCT;
