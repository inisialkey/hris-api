CREATE TYPE "public"."export_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('uploaded', 'validating', 'awaiting_confirmation', 'committing', 'completed', 'partially_completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "export_job_status" DEFAULT 'queued' NOT NULL,
	"params" jsonb NOT NULL,
	"file_id" uuid,
	"row_count" integer,
	"failure_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "import_job_status" DEFAULT 'uploaded' NOT NULL,
	"file_id" uuid NOT NULL,
	"error_report_file_id" uuid,
	"template_version" integer,
	"total_rows" integer,
	"valid_rows" integer,
	"error_rows" integer,
	"applied_rows" integer,
	"last_committed_batch" integer,
	"failure_code" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_error_report_file_id_files_id_fk" FOREIGN KEY ("error_report_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_export_jobs_list" ON "export_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_import_jobs_list" ON "import_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- manual: BR-IMP-005's concurrency guard — *"one active import per tenant + type"*.
-- A **partial** unique index, because the rule bounds only the four live
-- statuses: a tenant may hold any number of finished imports of one type, and
-- only a partial index can say that. drizzle-kit cannot express a `WHERE` on a
-- unique index inside `pgTable`, so it lives here (database-conventions §10
-- rule 4). §9 depends on this being an index rather than a pre-check: *"the
-- partial unique index decides at insert"*, which is the only version of the
-- guard with no race between the check and the write.
CREATE UNIQUE INDEX "uq_import_jobs_active"
  ON "import_jobs" ("tenant_id", "type")
  WHERE status IN ('uploaded','validating','awaiting_confirmation','committing');
--> statement-breakpoint
-- manual: RLS (ADR-0002, database-conventions §9.2) — in the creating migration,
-- so no window exists in which either table is readable without a tenant.
ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "import_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "import_jobs"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "export_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "export_jobs"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
