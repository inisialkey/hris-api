CREATE TYPE "public"."file_status" AS ENUM('staged', 'committed', 'quarantined');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"category" text NOT NULL,
	"original_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"status" "file_status" DEFAULT 'staged' NOT NULL,
	"commit_failure_code" text,
	"document_expires_at" date,
	"expiry_reminded_at" timestamp with time zone,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_files_entity" ON "files" USING btree ("tenant_id","entity_type","entity_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_files_expiry_scan" ON "files" USING btree ("tenant_id","document_expires_at") WHERE status = 'committed' AND document_expires_at IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_files_staged_sweep" ON "files" USING btree ("tenant_id","created_at") WHERE status = 'staged';--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4) and
-- ships in the creating migration for rule 8's reason — a later "add policies"
-- migration leaves a window in which the table exists unguarded.
--
-- Tenant-class, standard RLS. NULLIF per the 0006 note: the transaction-local
-- GUC resets to '' rather than NULL, and ''::uuid raises instead of yielding NULL.
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON files
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- §8: `sizeBytes` is "int ≥ 1". A validator states it for the field entry; the
-- CHECK states it for every writer, including the worker path UC-DOC-004 opens
-- and any future import — a zero-byte object is BR-DOC-004's
-- `DOC_UPLOAD_INCOMPLETE` case, and it must not be able to reach a row.
ALTER TABLE files
  ADD CONSTRAINT ck_files_size_bytes CHECK (size_bytes >= 1);
--> statement-breakpoint
-- BR-DOC-004: a digest exists exactly when the bytes have been verified. A
-- committed row without one would be a file nobody checked, wearing the status
-- that says somebody did.
ALTER TABLE files
  ADD CONSTRAINT ck_files_sha256_when_committed
  CHECK (status <> 'committed' OR sha256 IS NOT NULL);
