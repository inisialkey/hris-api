CREATE TYPE "public"."org_assignment_kind" AS ENUM('hire', 'transfer', 'promotion', 'correction');--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"address" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_department_id" uuid,
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
CREATE TABLE "job_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "org_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" "org_assignment_kind" NOT NULL,
	"note" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"job_level_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"reports_to_position_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "npwp" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_department_id_departments_id_fk" FOREIGN KEY ("parent_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_levels" ADD CONSTRAINT "job_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_assignments" ADD CONSTRAINT "org_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_assignments" ADD CONSTRAINT "org_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_assignments" ADD CONSTRAINT "org_assignments_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_assignments" ADD CONSTRAINT "org_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_job_level_id_job_levels_id_fk" FOREIGN KEY ("job_level_id") REFERENCES "public"."job_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_reports_to_position_id_positions_id_fk" FOREIGN KEY ("reports_to_position_id") REFERENCES "public"."positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_branches_tenant_id_company_id_code" ON "branches" USING btree ("tenant_id","company_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_branches_tenant_id_company_id" ON "branches" USING btree ("tenant_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_departments_tenant_id_company_id_code" ON "departments" USING btree ("tenant_id","company_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_departments_tenant_id_parent" ON "departments" USING btree ("tenant_id","parent_department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_levels_tenant_id_code" ON "job_levels" USING btree ("tenant_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_org_assignments_tenant_id_employee_id_effective_from" ON "org_assignments" USING btree ("tenant_id","employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_org_assignments_tenant_id_position_id" ON "org_assignments" USING btree ("tenant_id","position_id");--> statement-breakpoint
CREATE INDEX "idx_org_assignments_tenant_id_branch_id" ON "org_assignments" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_positions_tenant_id_company_id_code" ON "positions" USING btree ("tenant_id","company_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_positions_tenant_id_department" ON "positions" USING btree ("tenant_id","department_id");--> statement-breakpoint
CREATE INDEX "idx_positions_tenant_id_reports_to" ON "positions" USING btree ("tenant_id","reports_to_position_id");
--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4),
-- in the creating migration for rule 8's reason.
--
-- BR-ORG-001's three zones. Indonesia has exactly three, they are a fact about
-- the country rather than tenant policy, and organization.md §1 excludes
-- international timezones from V1 — so this is a CHECK and not a lookup table
-- nobody would ever add a row to.
ALTER TABLE branches ADD CONSTRAINT ck_branches_timezone
  CHECK (timezone IN ('Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'));
--> statement-breakpoint
-- A geofence centre is a point or it is nothing. One coordinate alone is not a
-- partially-known location, it is a bug that attendance would read as one.
ALTER TABLE branches ADD CONSTRAINT ck_branches_coordinates
  CHECK ((latitude IS NULL) = (longitude IS NULL));
--> statement-breakpoint
-- BR-ORG-002: at most one live placement per employee per date, in the database
-- (database-conventions §5.2 verbatim). This is the mechanism and not a backstop
-- — "which position did this employee hold on 3 March" has to have one answer,
-- and application code that got it wrong would produce two with no tiebreak.
--
-- `WHERE deleted_at IS NULL` so a cancelled future move (UC-ORG-004) stops
-- occupying its range the moment it is soft-deleted, which is what lets the
-- predecessor reopen in the same transaction.
ALTER TABLE org_assignments ADD CONSTRAINT excl_org_assignments_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (deleted_at IS NULL);
--> statement-breakpoint
-- Deferred-FK fulfilment. `setting_values.branch_id` shipped FK-less in 0009
-- because `branches` did not exist yet (settings.md §4.1 note, organization.md
-- §4.1 "deferred-FK fulfillment"). It exists now.
--
-- `holidays.branch_id` is the other half of that promise and is not here: the
-- holiday module has not been built, so its migration adds `fk_holidays_branches`
-- at creation like any ordinary forward reference. Fulfilling a deferral needs a
-- table to alter.
ALTER TABLE setting_values ADD CONSTRAINT fk_setting_values_branches
  FOREIGN KEY (branch_id) REFERENCES branches(id);
--> statement-breakpoint
-- RLS on all five, standard tenant isolation. NULLIF per the 0006 note: the
-- transaction-local GUC resets to '' rather than NULL, and ''::uuid raises
-- instead of yielding NULL.
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON branches
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON departments
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE job_levels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_levels FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_levels
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE positions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON positions
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE org_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_assignments
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);