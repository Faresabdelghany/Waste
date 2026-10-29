-- Service notifications (C18 of #291): one new table, the `notification`
-- planning areas a broadcast's rule narrows its customers to; a project's
-- notification rules grown by the service notices — a collection reminder,
-- a ticket replied to and completed, a route cancelled and late — and given
-- the project key the new table references them by; and the outbox's kind
-- grown by `ticket-replied`, a reply the customer may read. Every rule and
-- event already present is of a kind the grown checks keep. The rule's
-- project key is added before the key that references it, ahead of where
-- drizzle-kit writes it. Below
-- drizzle-kit's statements, what the new table owes the file: its fence,
-- trigger and audit trail.
CREATE TABLE "wms"."notification_rule_area" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_id" uuid NOT NULL,
	"planning_area_id" uuid NOT NULL,
	CONSTRAINT "notification_rule_area_rule_id_planning_area_id_key" UNIQUE("company_id","rule_id","planning_area_id")
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" DROP CONSTRAINT "notification_rule_event_one_of";--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_project_key" UNIQUE("company_id","project_id","id");--> statement-breakpoint
ALTER TABLE "wms"."notification_rule_area" ADD CONSTRAINT "notification_rule_area_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_rule_area" ADD CONSTRAINT "notification_rule_area_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_rule_area" ADD CONSTRAINT "notification_rule_area_rule_id_fk" FOREIGN KEY ("company_id","project_id","rule_id") REFERENCES "wms"."notification_rule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_rule_area" ADD CONSTRAINT "notification_rule_area_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_rule_area_planning_area_id_idx" ON "wms"."notification_rule_area" USING btree ("company_id","planning_area_id");--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided', 'alert-raised', 'ticket-assigned', 'bulky-booking-booked', 'bulky-booking-cancelled', 'ticket-replied'));--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_event_one_of" CHECK ("wms"."notification_rule"."event" in ('bulky-booking-booked', 'bulky-booking-cancelled', 'bulky-booking-collected', 'bulky-booking-not-collected', 'collection-reminder', 'ticket-replied', 'ticket-completed', 'route-cancelled', 'route-late'));--> statement-breakpoint
ALTER TABLE "wms"."notification_rule_area" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_rule_area_tenant_fence" ON "wms"."notification_rule_area" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "notification_rule_area_touch_updated_at" BEFORE UPDATE ON "wms"."notification_rule_area" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "notification_rule_area_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."notification_rule_area" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
