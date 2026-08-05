CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tenant_id" uuid,
	"aggregate_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_events_undispatched" ON "domain_events" USING btree ("id") WHERE dispatched_at IS NULL;