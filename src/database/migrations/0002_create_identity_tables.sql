CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"install_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"model" text NOT NULL,
	"os_version" text NOT NULL,
	"app_version" text NOT NULL,
	"fcm_token" text,
	"status" "device_status" DEFAULT 'active' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"refresh_token_hash" text NOT NULL,
	"trusted_device" boolean DEFAULT false NOT NULL,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_devices_tenant_id_install_id_active" ON "devices" USING btree ("tenant_id","install_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_devices_tenant_id_user_id" ON "devices" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessions_refresh_token_hash" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_id_user_id_live" ON "sessions" USING btree ("tenant_id","user_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_tenant_id_email" ON "users" USING btree ("tenant_id","email") WHERE deleted_at IS NULL;
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4).
-- It ships in the migration that creates these tables rather than in a later
-- one: a separate "add policies" migration leaves a window in which the table
-- exists unguarded, and an ordering coupling drizzle-kit cannot see (rule 8).
--
-- The statement-breakpoint markers are load-bearing. The migrator runs each
-- chunk through the extended query protocol, which accepts exactly one statement.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
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
CREATE POLICY tenant_isolation ON users
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON devices
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON sessions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The pre-tenant auth lookup role (multi-tenancy §4, authentication.md §4).
-- Login runs before a tenant context exists, so under plain hris_app with FORCE
-- RLS these SELECTs return zero rows and login is structurally impossible.
--
-- Every grant is written by hand and none arrive through ALTER DEFAULT
-- PRIVILEGES, so the role's entire reach is enumerable by grepping for its name.
-- It reads four tables, column-narrow on users, and writes nothing (leak test L7).
GRANT SELECT (id, tenant_id, email, password_hash, status, deleted_at) ON users TO hris_auth;
--> statement-breakpoint
GRANT SELECT ON sessions TO hris_auth;
--> statement-breakpoint
GRANT SELECT ON devices TO hris_auth;
--> statement-breakpoint
CREATE POLICY auth_lookup ON users FOR SELECT TO hris_auth USING (true);
--> statement-breakpoint
CREATE POLICY auth_lookup ON sessions FOR SELECT TO hris_auth USING (true);
--> statement-breakpoint
CREATE POLICY auth_lookup ON devices FOR SELECT TO hris_auth USING (true);
