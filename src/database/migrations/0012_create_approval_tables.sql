CREATE TYPE "public"."approval_action_type" AS ENUM('submit', 'approve', 'reject', 'return', 'cancel', 'reminded', 'escalated', 'skipped', 'rerouted');--> statement-breakpoint
CREATE TYPE "public"."approval_instance_status" AS ENUM('in_progress', 'approved', 'rejected', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_quorum" AS ENUM('all', 'any');--> statement-breakpoint
CREATE TYPE "public"."approval_step_status" AS ENUM('pending', 'active', 'approved', 'rejected', 'skipped');--> statement-breakpoint
CREATE TABLE "approval_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_id" uuid,
	"actor_user_id" uuid,
	"delegate_of_user_id" uuid,
	"action" "approval_action_type" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_assignees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"delegate_of_user_id" uuid,
	"status" "approval_step_status" DEFAULT 'active' NOT NULL,
	"acted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_chains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"request_type" text NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"conditions" jsonb,
	"steps" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"request_types" text[],
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"request_type" text NOT NULL,
	"request_id" uuid NOT NULL,
	"requester_employee_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"status" "approval_instance_status" DEFAULT 'in_progress' NOT NULL,
	"chain_snapshot" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"is_stuck" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"name" text,
	"quorum" "approval_quorum" NOT NULL,
	"sla_hours" integer,
	"status" "approval_step_status" DEFAULT 'pending' NOT NULL,
	"activated_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_instance_id_approval_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_step_id_approval_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."approval_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_delegate_of_user_id_users_id_fk" FOREIGN KEY ("delegate_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignees" ADD CONSTRAINT "approval_assignees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignees" ADD CONSTRAINT "approval_assignees_step_id_approval_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."approval_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignees" ADD CONSTRAINT "approval_assignees_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_assignees" ADD CONSTRAINT "approval_assignees_delegate_of_user_id_users_id_fk" FOREIGN KEY ("delegate_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_delegations" ADD CONSTRAINT "approval_delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_requester_employee_id_employees_id_fk" FOREIGN KEY ("requester_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_instance_id_approval_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_approval_actions_instance" ON "approval_actions" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_approval_assignees_step_user" ON "approval_assignees" USING btree ("step_id","approver_user_id");--> statement-breakpoint
CREATE INDEX "idx_approval_assignees_inbox" ON "approval_assignees" USING btree ("tenant_id","approver_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_chains_lookup" ON "approval_chains" USING btree ("tenant_id","request_type","company_id");--> statement-breakpoint
CREATE INDEX "idx_approval_delegations_lookup" ON "approval_delegations" USING btree ("tenant_id","delegator_user_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_approval_instances_live" ON "approval_instances" USING btree ("tenant_id","request_type","request_id") WHERE status = 'in_progress';--> statement-breakpoint
CREATE INDEX "idx_approval_instances_oversight" ON "approval_instances" USING btree ("tenant_id","company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_approval_steps_instance_idx" ON "approval_steps" USING btree ("instance_id","step_index");--> statement-breakpoint
CREATE INDEX "idx_approval_steps_sla_scan" ON "approval_steps" USING btree ("tenant_id","status","activated_at");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4) and
-- ships in the creating migration for rule 8's reason — a later "add policies"
-- migration leaves a window in which the tables exist unguarded.
--
-- All six are tenant-class (approval-engine §4: "all tenant-owned, standard
-- RLS"). NULLIF per the 0006 note: the transaction-local GUC resets to '' rather
-- than NULL, and ''::uuid raises instead of yielding NULL.
ALTER TABLE approval_chains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_chains FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_chains
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approval_instances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_instances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_instances
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_steps
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approval_assignees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_assignees FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_assignees
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approval_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_actions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_actions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE approval_delegations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE approval_delegations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON approval_delegations
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- BR-APRV-015, and the precedent audit-log §4.1 cites by name: append-only is a
-- grant, not a convention. `init-roles.sql` hands `hris_app` the four DML verbs
-- by default privilege, so the two that would rewrite an approval decision are
-- taken back here. A correction is a new row.
REVOKE UPDATE, DELETE ON approval_actions FROM hris_app;
--> statement-breakpoint
-- §8: "SLA ≥ 1 h when present". A validator states it for the field entry; the
-- CHECK states it for every writer, including a future import and a bad migration.
ALTER TABLE approval_steps
  ADD CONSTRAINT ck_approval_steps_sla_hours CHECK (sla_hours IS NULL OR sla_hours >= 1);
--> statement-breakpoint
-- §8's delegation date pair, for the same reason.
ALTER TABLE approval_delegations
  ADD CONSTRAINT ck_approval_delegations_range CHECK (start_date <= end_date);
