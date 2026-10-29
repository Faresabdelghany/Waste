-- Customer notices for bookings (O16 of #290, part b): one new table, a
-- project's notification rules, each mapping a customer notice to the
-- project's message template it is sent from; the outbox's two checks grown
-- by `bulky-booking-booked` and `bulky-booking-cancelled` and a
-- `bulky-booking` aggregate; and the delivery log keyed by its source event
-- and its customer, so a redelivered event queues a customer's notice once.
-- Every message already present names no source event, so the index takes
-- them all. Below drizzle-kit's statements, what the new table owes the
-- file: its fence, trigger and audit trail.
CREATE TABLE "wms"."notification_rule" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"template_id" uuid NOT NULL,
	CONSTRAINT "notification_rule_project_id_event_key" UNIQUE("company_id","project_id","event"),
	CONSTRAINT "notification_rule_event_one_of" CHECK ("wms"."notification_rule"."event" in ('bulky-booking-booked', 'bulky-booking-cancelled', 'bulky-booking-collected', 'bulky-booking-not-collected'))
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ADD CONSTRAINT "notification_rule_template_id_fk" FOREIGN KEY ("company_id","project_id","template_id") REFERENCES "wms"."message_template"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_rule_template_id_idx" ON "wms"."notification_rule" USING btree ("company_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_source_event_id_customer_id_idx" ON "wms"."message" USING btree ("company_id","source_event_id","customer_id") WHERE "wms"."message"."source_event_id" is not null and "wms"."message"."customer_id" is not null;--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided', 'alert-raised', 'ticket-assigned', 'bulky-booking-booked', 'bulky-booking-cancelled'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement', 'application', 'site-visit', 'alert', 'bulky-booking'));--> statement-breakpoint
ALTER TABLE "wms"."notification_rule" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_rule_tenant_fence" ON "wms"."notification_rule" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "notification_rule_touch_updated_at" BEFORE UPDATE ON "wms"."notification_rule" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "notification_rule_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."notification_rule" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('project', 'project_id');
