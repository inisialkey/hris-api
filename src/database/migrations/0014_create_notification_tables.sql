CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'push', 'email');--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	CONSTRAINT "notification_preferences_tenant_id_user_id_template_key_channel_pk" PRIMARY KEY("tenant_id","user_id","template_key","channel")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"params" jsonb NOT NULL,
	"deep_link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_deliveries_channel" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_status" ON "notification_deliveries" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_dedupe" ON "notifications" USING btree ("tenant_id","dedupe_key","user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_feed" ON "notifications" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
-- manual: everything below is hand-written (database-conventions §10 rule 4) and
-- ships in the creating migration for rule 8's reason — a later "add policies"
-- migration leaves a window in which the table exists unguarded.
--
-- All three are tenant-class. `notification_preferences` gets the same policy as
-- the other two even though it is a pure junction: it carries `tenant_id`, which
-- is what §2's classification turns on, and a user's opt-outs are still that
-- tenant's rows.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notifications
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_deliveries
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_preferences
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- §4.1's delivery lifecycle: `pending --> sent` is the transition that stamps
-- the time. Written as a constraint rather than left to the dispatch job because
-- that job is the one writer this module does not yet contain — a `sent` row
-- with no `sent_at` is a delivery nobody can date, and the check is here before
-- the writer that could produce one.
ALTER TABLE notification_deliveries
  ADD CONSTRAINT ck_notification_deliveries_sent_at
  CHECK (status <> 'sent' OR sent_at IS NOT NULL);
