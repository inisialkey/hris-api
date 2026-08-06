CREATE TYPE "public"."setting_level" AS ENUM('tenant', 'company', 'branch');--> statement-breakpoint
CREATE TYPE "public"."setting_type" AS ENUM('boolean', 'integer', 'decimal', 'string', 'enum', 'json');--> statement-breakpoint
CREATE TABLE "setting_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"module" text NOT NULL,
	"type" "setting_type" NOT NULL,
	"allowed_levels" "setting_level"[] NOT NULL,
	"default_value" jsonb NOT NULL,
	"validation" jsonb,
	"effective_dated" boolean DEFAULT false NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"required_permission" text,
	"description" text NOT NULL,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "setting_values" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"level" "setting_level" NOT NULL,
	"company_id" uuid,
	"branch_id" uuid,
	"value" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setting_values" ADD CONSTRAINT "setting_values_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setting_definitions_key" ON "setting_definitions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_setting_values_resolve" ON "setting_values" USING btree ("tenant_id","key","level","effective_from");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4),
-- in the creating migration for rule 8's reason.
--
-- Scope consistency, settings.md §4.1 verbatim. Without it a `branch` row could
-- carry a NULL company and resolution would have no chain to walk up.
ALTER TABLE setting_values ADD CONSTRAINT chk_setting_values_scope CHECK (
  (level = 'tenant'  AND company_id IS NULL AND branch_id IS NULL) OR
  (level = 'company' AND company_id IS NOT NULL AND branch_id IS NULL) OR
  (level = 'branch'  AND company_id IS NOT NULL AND branch_id IS NOT NULL)
);
--> statement-breakpoint
-- No overlapping intervals per key + exact scope (BR-SET-003). This is the
-- mechanism, not a backstop: history, scheduling and as-of reads are all the
-- same non-overlapping interval set, and application code that got it wrong
-- would produce two live values for one key with no way to say which won.
--
-- COALESCE to the nil uuid because NULL is not equal to NULL under `WITH =`,
-- which would let two tenant-level rows for one key coexist — exactly the case
-- the constraint exists for.
ALTER TABLE setting_values ADD CONSTRAINT excl_setting_values_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =, key WITH =, level WITH =,
    COALESCE(company_id, '00000000-0000-0000-0000-000000000000') WITH =,
    COALESCE(branch_id,  '00000000-0000-0000-0000-000000000000') WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );
--> statement-breakpoint
-- `setting_values` is tenant-owned and RLS'd; `setting_definitions` deliberately
-- is not. Definitions are platform data seeded from code (BR-SET-001), the same
-- class as `permissions` and protected the same way — by having no write path in
-- the application, not by a policy. Tenants set values; they never invent keys.
ALTER TABLE setting_values ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE setting_values FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- NULLIF per the 0006 note: the transaction-local GUC resets to '' rather than
-- NULL, and ''::uuid raises instead of yielding NULL.
CREATE POLICY tenant_isolation ON setting_values
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);