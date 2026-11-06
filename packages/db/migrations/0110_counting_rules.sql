-- Counting rules (#547 of #544): a company's rules counting the completed
-- emptyings at each property over a month, a quarter or a year, and the
-- ticket a rule opens on a property whose count reaches its limit, which
-- names the rule, the period and the count, one per rule, property and
-- period; `counting-rule` joins the ticket's sources. drizzle-kit's statements
-- first; then the rule's fence, trigger and audit trail.
CREATE TABLE "wms"."counting_rule" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"period" text NOT NULL,
	"limit" integer NOT NULL,
	"waste_fraction_id" uuid,
	"container_type_id" uuid,
	"ticket_type_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"notifies_team" boolean DEFAULT false NOT NULL,
	CONSTRAINT "counting_rule_name_key" UNIQUE("company_id","name"),
	CONSTRAINT "counting_rule_tenant_key" UNIQUE("company_id","id"),
	CONSTRAINT "counting_rule_status_one_of" CHECK ("wms"."counting_rule"."status" in ('active', 'inactive')),
	CONSTRAINT "counting_rule_period_one_of" CHECK ("wms"."counting_rule"."period" in ('month', 'quarter', 'year')),
	CONSTRAINT "counting_rule_limit_range" CHECK ("wms"."counting_rule"."limit" between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket" DROP CONSTRAINT "ticket_source_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "counting_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "counted_from" date;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "counted" integer;--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_ticket_type_id_fk" FOREIGN KEY ("company_id","ticket_type_id") REFERENCES "wms"."ticket_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ADD CONSTRAINT "counting_rule_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counting_rule_waste_fraction_id_idx" ON "wms"."counting_rule" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "counting_rule_container_type_id_idx" ON "wms"."counting_rule" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "counting_rule_ticket_type_id_idx" ON "wms"."counting_rule" USING btree ("company_id","ticket_type_id");--> statement-breakpoint
CREATE INDEX "counting_rule_team_id_idx" ON "wms"."counting_rule" USING btree ("company_id","team_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_counting_rule_id_fk" FOREIGN KEY ("company_id","counting_rule_id") REFERENCES "wms"."counting_rule"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_counting_key" ON "wms"."ticket" USING btree ("company_id","counting_rule_id","property_id","counted_from") WHERE "wms"."ticket"."counting_rule_id" is not null;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_counting_shape" CHECK (("wms"."ticket"."counting_rule_id" is null) = ("wms"."ticket"."counted_from" is null) and ("wms"."ticket"."counting_rule_id" is null) = ("wms"."ticket"."counted" is null) and ("wms"."ticket"."counting_rule_id" is null or "wms"."ticket"."property_id" is not null));--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_counted_positive" CHECK ("wms"."ticket"."counted" > 0);--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_source_one_of" CHECK ("wms"."ticket"."source" in ('office', 'phone', 'email', 'portal', 'driver-app', 'dispatch', 'import', 'integration', 'service-provider', 'counting-rule'));
--> statement-breakpoint
ALTER TABLE "wms"."counting_rule" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "counting_rule_tenant_fence" ON "wms"."counting_rule" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "counting_rule_touch_updated_at" BEFORE UPDATE ON "wms"."counting_rule" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "counting_rule_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."counting_rule" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
