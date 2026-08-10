CREATE TYPE "public"."inbox_item_status" AS ENUM('open', 'done', 'closed');--> statement-breakpoint
CREATE TYPE "public"."inbox_item_type" AS ENUM('approval_task', 'acknowledgment');--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "inbox_item_type" NOT NULL,
	"status" "inbox_item_status" DEFAULT 'open' NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"params" jsonb NOT NULL,
	"source_ref" jsonb NOT NULL,
	"deep_link" text NOT NULL,
	"due_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbox_items_dedupe" ON "inbox_items" USING btree ("tenant_id","user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_inbox_items_list" ON "inbox_items" USING btree ("tenant_id","user_id","status","created_at");--> statement-breakpoint
-- manual: RLS per database-conventions §9.2, in the migration that creates the
-- table (ADR-0013 decision 8 — a separate "add policies" migration would leave a
-- window where the table exists unguarded).
ALTER TABLE inbox_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inbox_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON inbox_items
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- manual: §4's stated invariant — "`done_at`/`closed_reason` mutually exclusive
-- with each other's status". Three writers reach this table (materialization,
-- the four closure paths, and acknowledge) and the closure paths are handlers
-- that will one day be retried by a relay nobody has written yet, so the
-- invariant is enforced where a retry cannot get it wrong.
ALTER TABLE inbox_items
  ADD CONSTRAINT ck_inbox_items_terminal_stamps
  CHECK (
    CASE status
      WHEN 'open' THEN done_at IS NULL AND closed_reason IS NULL
      WHEN 'done' THEN done_at IS NOT NULL AND closed_reason IS NULL
      ELSE done_at IS NULL AND closed_reason IS NOT NULL
    END
  );
--> statement-breakpoint
-- manual: UC-INB-002's closure lookups (A-199, hris-handbook PR #33). BR-INB-006
-- closes siblings by step and remainders by instance, and §4 stores both keys
-- inside `source_ref` jsonb — which database-conventions §1.8 forbids filtering
-- on, and which is nonetheless the contract. One expression index answers both,
-- because `approval.step.decided` carries the instance id alongside the step id;
-- partial on `open` because closure never touches anything else, which keeps it
-- the size of the live task list rather than of the retention window.
CREATE INDEX idx_inbox_items_source_open
  ON inbox_items (tenant_id, (source_ref->>'instanceId'), (source_ref->>'stepId'))
  WHERE status = 'open';
