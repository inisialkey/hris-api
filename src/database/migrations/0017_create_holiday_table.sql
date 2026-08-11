CREATE TYPE "public"."holiday_kind" AS ENUM('national', 'cuti_bersama', 'custom');--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"branch_id" uuid,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kind" "holiday_kind" NOT NULL,
	"observed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_holidays_scope_date_kind" ON "holidays" USING btree ("tenant_id",COALESCE("company_id", '00000000-0000-0000-0000-000000000000'),COALESCE("branch_id", '00000000-0000-0000-0000-000000000000'),"date","kind") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_holidays_resolve" ON "holidays" USING btree ("tenant_id","date") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_holidays_year" ON "holidays" USING btree ("tenant_id","company_id","date");--> statement-breakpoint
-- manual: holiday.md §4.1's hand-written objects (database-conventions §10 rule 4).
--
-- BR-HOL-005 — branch scope implies company scope. A branch row without its
-- company would resolve against a chain with a hole in it: the reducer walks
-- tenant → company → branch, and a row that names the third without the second
-- is a scope no query filters on.
ALTER TABLE "holidays" ADD CONSTRAINT "ck_holidays_scope_pair"
  CHECK (branch_id IS NULL OR company_id IS NOT NULL);
--> statement-breakpoint
-- ADR-0002 layer 2, database-conventions §9.2. `NULLIF` because a transaction-local
-- setting reverts to the empty string rather than to NULL on a pooled connection.
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON holidays
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
