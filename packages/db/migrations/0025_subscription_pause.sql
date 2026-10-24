CREATE TABLE "wms"."subscription_pause" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"subscription_id" uuid NOT NULL,
	CONSTRAINT "subscription_pause_validity" CHECK ("wms"."subscription_pause"."valid_to" is null or "wms"."subscription_pause"."valid_to" > "wms"."subscription_pause"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."subscription_pause" ADD CONSTRAINT "subscription_pause_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription_pause" ADD CONSTRAINT "subscription_pause_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."subscription_pause" ADD CONSTRAINT "subscription_pause_subscription_id_fk" FOREIGN KEY ("company_id","project_id","subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_pause_subscription_id_idx" ON "wms"."subscription_pause" USING btree ("company_id","subscription_id");
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md, #291 slice 10): the
-- tenant fence and the touch trigger every current-state table carries, the
-- exclusion constraint that holds one pause of a subscription in force at a
-- time, and the audit trail's trigger, the pause a set of its subscription
-- (src/sql/audit-trail.ts), so an agreement's history reaches it two levels
-- down.
ALTER TABLE "wms"."subscription_pause" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "subscription_pause_tenant_fence" ON "wms"."subscription_pause" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "subscription_pause_touch_updated_at" BEFORE UPDATE ON "wms"."subscription_pause" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."subscription_pause" ADD CONSTRAINT "subscription_pause_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "subscription_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "subscription_pause_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."subscription_pause" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('subscription', 'subscription_id');
--> statement-breakpoint
-- The public door (ADR-0010): the collection days by address read a pause, so a
-- paused address shows no day generation will not plan (src/sql/public-door.ts,
-- SUBSCRIPTION_PAUSE_DOOR): the period under its subscription, nothing else.
GRANT SELECT ("company_id", "project_id", "subscription_id", "valid_from", "valid_to") ON "wms"."subscription_pause" TO wms_public;
--> statement-breakpoint
CREATE POLICY "subscription_pause_public_door" ON "wms"."subscription_pause" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "subscription_pause"."company_id" and "published"."id" = "subscription_pause"."project_id" and "published"."public_slug" is not null));
