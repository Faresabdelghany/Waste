-- Messaging (#291 C15): two new tables, a project's message templates and the
-- delivery log of every message sent from them. Below drizzle-kit's
-- statements, what the tables owe the file: their fences and triggers, and
-- the templates' audit trail; the delivery log is exempt.
CREATE TABLE "wms"."message" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"template_id" uuid,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"reason" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "message_channel_one_of" CHECK ("wms"."message"."channel" in ('email', 'sms')),
	CONSTRAINT "message_purpose_one_of" CHECK ("wms"."message"."purpose" in ('service', 'billing')),
	CONSTRAINT "message_status_one_of" CHECK ("wms"."message"."status" in ('queued', 'sent', 'failed', 'withheld')),
	CONSTRAINT "message_attempts_range" CHECK ("wms"."message"."attempts" >= 0),
	CONSTRAINT "message_sent_shape" CHECK (("wms"."message"."status" = 'sent') = ("wms"."message"."sent_at" is not null and "wms"."message"."provider" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."message_template" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "message_template_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "message_template_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "message_template_purpose_one_of" CHECK ("wms"."message_template"."purpose" in ('service', 'billing')),
	CONSTRAINT "message_template_channel_one_of" CHECK ("wms"."message_template"."channel" in ('email', 'sms')),
	CONSTRAINT "message_template_status_one_of" CHECK ("wms"."message_template"."status" in ('active', 'inactive')),
	CONSTRAINT "message_template_subject_shape" CHECK (("wms"."message_template"."channel" = 'email') = ("wms"."message_template"."subject" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_template_id_fk" FOREIGN KEY ("company_id","project_id","template_id") REFERENCES "wms"."message_template"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message" ADD CONSTRAINT "message_contact_id_fk" FOREIGN KEY ("company_id","contact_id") REFERENCES "wms"."customer_contact"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message_template" ADD CONSTRAINT "message_template_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."message_template" ADD CONSTRAINT "message_template_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_project_id_idx" ON "wms"."message" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "message_template_id_idx" ON "wms"."message" USING btree ("company_id","template_id");--> statement-breakpoint
CREATE INDEX "message_customer_id_idx" ON "wms"."message" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "message_contact_id_idx" ON "wms"."message" USING btree ("company_id","contact_id");--> statement-breakpoint
ALTER TABLE "wms"."message_template" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "message_template_tenant_fence" ON "wms"."message_template" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "message_template_touch_updated_at" BEFORE UPDATE ON "wms"."message_template" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."message" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "message_tenant_fence" ON "wms"."message" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "message_touch_updated_at" BEFORE UPDATE ON "wms"."message" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "message_template_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."message_template" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
