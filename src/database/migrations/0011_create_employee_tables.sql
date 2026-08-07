CREATE TYPE "public"."gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."marital_status" AS ENUM('single', 'married', 'divorced', 'widowed');--> statement-breakpoint
CREATE TYPE "public"."ptkp_status" AS ENUM('tk_0', 'tk_1', 'tk_2', 'tk_3', 'k_0', 'k_1', 'k_2', 'k_3', 'k_i_0', 'k_i_1', 'k_i_2', 'k_i_3');--> statement-breakpoint
CREATE TYPE "public"."religion" AS ENUM('islam', 'protestant', 'catholic', 'hindu', 'buddhist', 'confucian');--> statement-breakpoint
CREATE TYPE "public"."employee_status_source" AS ENUM('hire', 'resignation', 'termination', 'leave', 'admin');--> statement-breakpoint
CREATE TYPE "public"."family_relationship" AS ENUM('spouse', 'child', 'parent', 'sibling', 'other');--> statement-breakpoint
CREATE TABLE "employee_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" "employment_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"file_id" uuid,
	"note" text,
	"last_reminded_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_family_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" "family_relationship" NOT NULL,
	"birth_date" date,
	"phone" text,
	"is_emergency_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "employee_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"status" "employee_status" NOT NULL,
	"source" "employee_status_source" NOT NULL,
	"source_id" uuid,
	"effective_date" date NOT NULL,
	"reason" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tenant_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wrapped_dek" text NOT NULL,
	"wrapped_index_key" text NOT NULL,
	"kek_version" text NOT NULL,
	"dek_version" integer DEFAULT 1 NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "nik" text NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "nik_bidx" text NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "npwp" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "npwp_bidx" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bpjs_kesehatan_number" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bpjs_ketenagakerjaan_number" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bank_account_holder" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "birth_place" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "birth_date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "gender" "gender" NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "marital_status" "marital_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "religion" "religion";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "ptkp_status" "ptkp_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "personal_email" text;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_family_members" ADD CONSTRAINT "employee_family_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_family_members" ADD CONSTRAINT "employee_family_members_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_status_history" ADD CONSTRAINT "employee_status_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_status_history" ADD CONSTRAINT "employee_status_history_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_employee_contracts_tenant_id_employee_id_start_date" ON "employee_contracts" USING btree ("tenant_id","employee_id","start_date");--> statement-breakpoint
CREATE INDEX "idx_employee_contracts_reminder_scan" ON "employee_contracts" USING btree ("tenant_id","end_date") WHERE kind = 'pkwt' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_employee_family_members_tenant_id_employee_id" ON "employee_family_members" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_employee_status_history_tenant_id_employee_id_effective_date" ON "employee_status_history" USING btree ("tenant_id","employee_id","effective_date");--> statement-breakpoint
CREATE INDEX "idx_employee_status_history_due" ON "employee_status_history" USING btree ("tenant_id","effective_date") WHERE applied_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenant_keys_tenant_id" ON "tenant_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE VIEW "public"."employee_directory" WITH (security_invoker = true) AS (SELECT id AS employee_id, tenant_id, company_id, user_id, employee_number, full_name, status, join_date
        FROM employees
        WHERE deleted_at IS NULL);--> statement-breakpoint

-- manual: employee.md §4.1's hand-written objects (database-conventions §10 rule 4).
--
-- BR-EMP-001 — one live employment per person per tenant. The uniqueness is on
-- the **blind index**, not on NIK: ADR-0016 replaced the plaintext column, so
-- the conventions-era `uq_employees_tenant_id_nik` example has nothing left to
-- index. The predicate is what makes rehire work — a terminal row stops holding
-- the NIK, so the same person can be hired again as a new row with a new number.
CREATE UNIQUE INDEX "uq_employees_tenant_id_nik_bidx"
  ON "employees" ("tenant_id", "nik_bidx")
  WHERE deleted_at IS NULL AND status IN ('active', 'on_leave');
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_employees_tenant_id_npwp_bidx"
  ON "employees" ("tenant_id", "npwp_bidx")
  WHERE deleted_at IS NULL AND status IN ('active', 'on_leave') AND npwp_bidx IS NOT NULL;
--> statement-breakpoint

-- BR-EMP-007 — the contract kind decides whether an end date exists at all. A
-- PKWT without one is an unbounded fixed-term contract, which is a contradiction
-- the reminder ladder would then silently never fire for.
ALTER TABLE "employee_contracts" ADD CONSTRAINT "ck_employee_contracts_end_by_kind"
  CHECK ((kind = 'pkwt' AND end_date IS NOT NULL) OR (kind = 'pkwtt' AND end_date IS NULL));
--> statement-breakpoint

-- BR-EMP-007 — per-employee contract ranges never overlap, enforced where two
-- concurrent writers cannot beat it. **Inclusive end**: a contract ends *on*
-- `end_date`, so the range is `'[]'` rather than the `'[)'` every other
-- effective-dated table in the system uses, and a renewal therefore starts the
-- day *after* its predecessor ends rather than on the same date.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "excl_employee_contracts_no_overlap"
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);
--> statement-breakpoint

-- database-conventions §9.2 on all three tenant-class tables. `tenant_keys` is
-- platform-class (system-administration.md §4.1) and carries no policy — its
-- reader is the crypto helper, which runs before a tenant transaction exists.
ALTER TABLE "employee_contracts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "employee_contracts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "employee_contracts"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "employee_status_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "employee_status_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "employee_status_history"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "employee_family_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "employee_family_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "employee_family_members"
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
