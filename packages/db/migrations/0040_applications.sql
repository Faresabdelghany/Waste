CREATE TABLE "wms"."application" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"channel" text NOT NULL,
	"received_on" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid,
	"shared_collection_point_id" uuid,
	"subscription_id" uuid,
	"statement" text NOT NULL,
	CONSTRAINT "application_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "application_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "application_kind_one_of" CHECK ("wms"."application"."kind" in ('exemption', 'pause', 'longer-interval', 'home-composting', 'shared-bin', 'assisted-collection', 'fee-correction')),
	CONSTRAINT "application_status_one_of" CHECK ("wms"."application"."status" in ('received', 'in-review', 'decided', 'withdrawn')),
	CONSTRAINT "application_channel_one_of" CHECK ("wms"."application"."channel" in ('phone', 'email', 'letter', 'counter', 'portal')),
	CONSTRAINT "application_one_place" CHECK ("wms"."application"."property_id" is null or "wms"."application"."shared_collection_point_id" is null),
	CONSTRAINT "application_statement_given" CHECK (length(btrim("wms"."application"."statement")) > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."application_decision" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"application_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"conditions" text,
	"granted_from" date,
	"granted_to" date,
	"appeal_text" text,
	"decided_by" uuid NOT NULL,
	CONSTRAINT "application_decision_outcome_one_of" CHECK ("wms"."application_decision"."outcome" in ('granted', 'partly-granted', 'refused')),
	CONSTRAINT "application_decision_period_shape" CHECK (case when "wms"."application_decision"."outcome" = 'refused' then "wms"."application_decision"."granted_from" is null and "wms"."application_decision"."granted_to" is null else "wms"."application_decision"."granted_from" is not null and ("wms"."application_decision"."granted_to" is null or "wms"."application_decision"."granted_to" > "wms"."application_decision"."granted_from") end),
	CONSTRAINT "application_decision_appeal_shape" CHECK ("wms"."application_decision"."outcome" = 'granted' or length(btrim(coalesce("wms"."application_decision"."appeal_text", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application" ADD CONSTRAINT "application_subscription_id_fk" FOREIGN KEY ("company_id","project_id","subscription_id") REFERENCES "wms"."subscription"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application_decision" ADD CONSTRAINT "application_decision_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application_decision" ADD CONSTRAINT "application_decision_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application_decision" ADD CONSTRAINT "application_decision_application_id_fk" FOREIGN KEY ("company_id","project_id","application_id") REFERENCES "wms"."application"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."application_decision" ADD CONSTRAINT "application_decision_decided_by_fk" FOREIGN KEY ("company_id","decided_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_project_id_idx" ON "wms"."application" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "application_customer_id_idx" ON "wms"."application" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "application_property_id_idx" ON "wms"."application" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "application_shared_collection_point_id_idx" ON "wms"."application" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
CREATE INDEX "application_subscription_id_idx" ON "wms"."application" USING btree ("company_id","subscription_id");--> statement-breakpoint
CREATE INDEX "application_decision_application_id_idx" ON "wms"."application_decision" USING btree ("company_id","application_id","id");--> statement-breakpoint
CREATE INDEX "application_decision_project_id_idx" ON "wms"."application_decision" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "application_decision_decided_by_idx" ON "wms"."application_decision" USING btree ("company_id","decided_by");--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement', 'application'));--> statement-breakpoint
ALTER TABLE "wms"."application" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "application_tenant_fence" ON "wms"."application" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "application_touch_updated_at" BEFORE UPDATE ON "wms"."application" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."application_decision" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "application_decision_tenant_fence" ON "wms"."application_decision" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."application_decision" FROM wms_api;
--> statement-breakpoint
CREATE TRIGGER "application_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."application" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
