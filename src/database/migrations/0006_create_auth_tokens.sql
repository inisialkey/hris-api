CREATE TYPE "public"."token_purpose" AS ENUM('password_reset', 'invite');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "token_purpose" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_auth_tokens_token_hash" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_auth_tokens_tenant_id_user_id" ON "auth_tokens" USING btree ("tenant_id","user_id");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4).
-- It ships in the migration that creates these tables rather than in a later
-- one: a separate "add policies" migration leaves a window in which the table
-- exists unguarded, and an ordering coupling drizzle-kit cannot see (rule 8).
--
-- The statement-breakpoint markers are load-bearing. The migrator runs each
-- chunk through the extended query protocol, which accepts exactly one statement.
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
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
CREATE POLICY tenant_isolation ON auth_tokens
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- The fourth table of the hris_auth lookup set: reset and invite tokens are
-- consumed before a tenant context exists, exactly as the login scan is.
GRANT SELECT ON auth_tokens TO hris_auth;
--> statement-breakpoint
CREATE POLICY auth_lookup ON auth_tokens FOR SELECT TO hris_auth USING (true);
