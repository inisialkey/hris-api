CREATE TABLE "roster_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_id" uuid,
	"pattern_id" uuid NOT NULL,
	"cycle_anchor_date" date NOT NULL,
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
CREATE TABLE "roster_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"shift_id" uuid,
	"works_on_holiday" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "shift_pattern_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"day_index" integer NOT NULL,
	"shift_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "shift_patterns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"cycle_length" integer NOT NULL,
	"observes_holidays" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"break_start_time" time,
	"late_tolerance_minutes" integer DEFAULT 0 NOT NULL,
	"early_leave_tolerance_minutes" integer DEFAULT 0 NOT NULL,
	"punch_in_before_minutes" integer DEFAULT 60 NOT NULL,
	"punch_out_after_minutes" integer DEFAULT 60 NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "roster_assignments_pattern_id_shift_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."shift_patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_days" ADD CONSTRAINT "roster_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_days" ADD CONSTRAINT "roster_days_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_days" ADD CONSTRAINT "roster_days_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pattern_days" ADD CONSTRAINT "shift_pattern_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pattern_days" ADD CONSTRAINT "shift_pattern_days_pattern_id_shift_patterns_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."shift_patterns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_pattern_days" ADD CONSTRAINT "shift_pattern_days_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_patterns" ADD CONSTRAINT "shift_patterns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_roster_assignments_tenant_id_employee_id_effective_from" ON "roster_assignments" USING btree ("tenant_id","employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_roster_assignments_tenant_id_company_id_effective_from" ON "roster_assignments" USING btree ("tenant_id","company_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_roster_assignments_tenant_id_pattern_id" ON "roster_assignments" USING btree ("tenant_id","pattern_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_roster_days_tenant_id_employee_id_date" ON "roster_days" USING btree ("tenant_id","employee_id","date") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_roster_days_tenant_id_date" ON "roster_days" USING btree ("tenant_id","date");--> statement-breakpoint
CREATE INDEX "idx_roster_days_tenant_id_shift_id" ON "roster_days" USING btree ("tenant_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shift_pattern_days_tenant_id_pattern_id_day_index" ON "shift_pattern_days" USING btree ("tenant_id","pattern_id","day_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shift_patterns_tenant_id_company_id_code" ON "shift_patterns" USING btree ("tenant_id","company_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shifts_tenant_id_company_id_code" ON "shifts" USING btree ("tenant_id","company_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_shifts_tenant_id_company_id" ON "shifts" USING btree ("tenant_id","company_id");--> statement-breakpoint
-- manual: shift.md §4.1's hand-written objects (database-conventions §10 rule 4).
--
-- BR-SHF-001 — a shift is a window, and a window of zero length is not one.
-- `end_time < start_time` is legal and means the shift crosses midnight, which is
-- why this is `<>` and not `>`: naming §2.4's illustrative `ck_shifts_end_after_start`
-- was renamed in the anchor for exactly this reason.
ALTER TABLE "shifts" ADD CONSTRAINT "ck_shifts_times_differ"
  CHECK (end_time <> start_time);
--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "ck_shifts_tolerances_non_negative"
  CHECK (break_minutes >= 0
     AND late_tolerance_minutes >= 0
     AND early_leave_tolerance_minutes >= 0
     AND punch_in_before_minutes >= 0
     AND punch_out_after_minutes >= 0);
--> statement-breakpoint
ALTER TABLE "shift_patterns" ADD CONSTRAINT "ck_shift_patterns_cycle_length"
  CHECK (cycle_length BETWEEN 1 AND 31);
--> statement-breakpoint
-- The upper bound against `cycle_length` is validated in the application:
-- cross-row, cheap there, awkward as a constraint (§4.1).
ALTER TABLE "shift_pattern_days" ADD CONSTRAINT "ck_shift_pattern_days_day_index"
  CHECK (day_index >= 0);
--> statement-breakpoint
-- BR-SHF-007, both invariants in one constraint: one live arrangement per
-- employee, one live default per company. Per-employee rows key on the employee
-- and default rows on the company, and UUIDs never collide across the two — which
-- is what lets a single exclusion cover what would otherwise be two.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "roster_assignments" ADD CONSTRAINT "excl_roster_assignments_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =,
    COALESCE(employee_id, company_id) WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (deleted_at IS NULL);
--> statement-breakpoint
-- ADR-0002 layer 2, database-conventions §9.2, on all five tables.
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON shifts
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE shift_patterns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shift_patterns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON shift_patterns
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE shift_pattern_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shift_pattern_days FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON shift_pattern_days
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE roster_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roster_assignments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON roster_assignments
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE roster_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE roster_days FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON roster_days
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
