CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'platform_op');--> statement-breakpoint
CREATE TABLE "audit_anchors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"row_count" integer NOT NULL,
	"digest" text NOT NULL,
	"prev_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"impersonator_id" uuid,
	"request_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"diff" jsonb,
	"metadata" jsonb,
	"event_id" uuid
);
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audit_anchors_day" ON "audit_anchors" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audit_logs_event" ON "audit_logs" USING btree ("event_id") WHERE event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_logs_cursor" ON "audit_logs" USING btree ("tenant_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" USING btree ("tenant_id","actor_user_id","occurred_at");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4),
-- and ships in the creating migration for rule 8's reason — a later "add
-- policies" migration leaves a window in which the table exists unguarded.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- NULLIF per the 0006 note: the transaction-local GUC resets to '' rather than
-- NULL, and ''::uuid raises instead of yielding NULL.
CREATE POLICY tenant_isolation ON audit_logs
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_anchors FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_anchors
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- BR-AUD-001, and the reason this module has no write API: append-only is a
-- grant, not a convention. `init-roles.sql` hands `hris_app` the four DML verbs
-- by default privilege, so the two that would rewrite history are taken back
-- here. Corrections are new rows; the archive job's hard delete (UC-AUD-006)
-- runs as its own role, which is why this revoke can stand for the application
-- without blocking retention.
REVOKE UPDATE, DELETE ON audit_logs FROM hris_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_anchors FROM hris_app;