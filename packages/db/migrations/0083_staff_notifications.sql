-- Staff notifications (O16 of #290, part a): one new table, a staff member's
-- notification preferences; the outbox's two checks grown by `alert-raised` and
-- `ticket-assigned` and an `alert` aggregate; and the delivery log addressing a
-- user account as well as a customer. `message.customer_id` loses its NOT NULL
-- behind `message_recipient_exactly_one`, which says which rows may hold the
-- null — a staff message's — and every row already present passes it, so no
-- guard is needed; the purpose check takes `staff`. Below drizzle-kit's
-- statements, what the new table owes the file: its fence, trigger and audit trail.
CREATE TABLE "wms"."notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_account_id" uuid NOT NULL,
	"event" text NOT NULL,
	"min_severity" text,
	CONSTRAINT "notification_preference_user_account_id_event_key" UNIQUE("company_id","user_account_id","event"),
	CONSTRAINT "notification_preference_event_one_of" CHECK ("wms"."notification_preference"."event" in ('alert-raised', 'ticket-assigned')),
	CONSTRAINT "notification_preference_min_severity_one_of" CHECK ("wms"."notification_preference"."min_severity" in ('critical', 'high', 'medium', 'low')),
	CONSTRAINT "notification_preference_min_severity_shape" CHECK (("wms"."notification_preference"."event" = 'alert-raised') = ("wms"."notification_preference"."min_severity" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."message" DROP CONSTRAINT "message_purpose_one_of";--> statement-breakpoint
ALTER TABLE "wms"."message" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD COLUMN "user_account_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD COLUMN "source_event_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."notification_preference" ADD CONSTRAINT "notification_preference_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."notification_preference" ADD CONSTRAINT "notification_preference_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_user_account_id_idx" ON "wms"."message" USING btree ("company_id","user_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_source_event_id_user_account_id_idx" ON "wms"."message" USING btree ("company_id","source_event_id","user_account_id") WHERE "wms"."message"."source_event_id" is not null and "wms"."message"."user_account_id" is not null;--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided', 'alert-raised', 'ticket-assigned'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement', 'application', 'site-visit', 'alert'));--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_recipient_exactly_one" CHECK (("wms"."message"."customer_id" is not null)::int + ("wms"."message"."user_account_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_purpose_one_of" CHECK ("wms"."message"."purpose" in ('service', 'billing', 'staff'));--> statement-breakpoint
ALTER TABLE "wms"."notification_preference" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_preference_tenant_fence" ON "wms"."notification_preference" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "notification_preference_touch_updated_at" BEFORE UPDATE ON "wms"."notification_preference" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "notification_preference_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."notification_preference" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('user_account', 'user_account_id');
