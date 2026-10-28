-- A Customer's Contact Persons (#291 C14): one new table, a named person who
-- speaks for an organisation Customer, with a role and the channels they are
-- reached on. Below drizzle-kit's statements, what the table owes the file:
-- its fence and trigger, and its audit trail as its customer's child.
CREATE TABLE "wms"."customer_contact" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"email" text,
	"phone" text,
	"status" text NOT NULL,
	CONSTRAINT "customer_contact_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "customer_contact_role_one_of" CHECK ("wms"."customer_contact"."role" in ('primary', 'billing', 'operations', 'on-site', 'other')),
	CONSTRAINT "customer_contact_status_one_of" CHECK ("wms"."customer_contact"."status" in ('active', 'inactive')),
	CONSTRAINT "customer_contact_email_lowercase" CHECK ("wms"."customer_contact"."email" = lower("wms"."customer_contact"."email")),
	CONSTRAINT "customer_contact_channel_shape" CHECK ("wms"."customer_contact"."email" is not null or "wms"."customer_contact"."phone" is not null)
);
--> statement-breakpoint
ALTER TABLE "wms"."customer_contact" ADD CONSTRAINT "customer_contact_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_contact_customer_id_idx" ON "wms"."customer_contact" USING btree ("company_id","customer_id");--> statement-breakpoint
ALTER TABLE "wms"."customer_contact" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "customer_contact_tenant_fence" ON "wms"."customer_contact" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "customer_contact_touch_updated_at" BEFORE UPDATE ON "wms"."customer_contact" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "customer_contact_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."customer_contact" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('customer', 'customer_id');
