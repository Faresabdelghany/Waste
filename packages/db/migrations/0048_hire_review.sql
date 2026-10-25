ALTER TABLE "wms"."billing_run_exclusion" DROP CONSTRAINT "billing_run_exclusion_reason_one_of";--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "hold_for_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "held_by" uuid;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_held_by_fk" FOREIGN KEY ("company_id","held_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billable_event_held_by_idx" ON "wms"."billable_event" USING btree ("company_id","held_by");--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_hold_shape" CHECK (("wms"."billable_event"."held_at" is null) = ("wms"."billable_event"."hold_reason" is null) and ("wms"."billable_event"."held_by" is null or "wms"."billable_event"."held_at" is not null) and ("wms"."billable_event"."held_at" is null or "wms"."billable_event"."block_reason" is null));--> statement-breakpoint
ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_reason_one_of" CHECK ("wms"."billing_run_exclusion"."reason" in ('all-events-blocked', 'all-events-held', 'all-events-blocked-or-held'));