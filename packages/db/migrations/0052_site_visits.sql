-- #393 (M4 of #293): recycling-centre visits. The register of Access
-- Credentials, the Site Visit ledger and the fractions each brought, and a
-- project's Visit Rules with their ladders and free fractions; product's unit
-- gains `visit`, the outbox the visit's two kinds about a `site-visit`, and
-- billable_event the `visit` kind naming its visit, with the consumer's
-- `visit-voided` cancel reason. Below drizzle-kit's statements: each new
-- table's fence and trigger, the credential's and the rule's no-overlap, and
-- the audit triggers. Nothing present changes meaning: no product, event or
-- outbox row holds a new value yet, and every billable event already passes
-- the respelled kind shape, its new clause being the new kind's alone.
CREATE TABLE "wms"."access_credential" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"customer_id" uuid,
	"agreement_id" uuid,
	"property_id" uuid,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	CONSTRAINT "access_credential_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "access_credential_validity" CHECK ("wms"."access_credential"."valid_to" is null or "wms"."access_credential"."valid_to" > "wms"."access_credential"."valid_from"),
	CONSTRAINT "access_credential_kind_one_of" CHECK ("wms"."access_credential"."kind" in ('plate', 'card')),
	CONSTRAINT "access_credential_value_shape" CHECK ("wms"."access_credential"."value" ~ '^[A-Z0-9-]+$'),
	CONSTRAINT "access_credential_holder_shape" CHECK (case when "wms"."access_credential"."property_id" is not null then "wms"."access_credential"."customer_id" is null and "wms"."access_credential"."agreement_id" is null else "wms"."access_credential"."customer_id" is not null and "wms"."access_credential"."agreement_id" is not null end),
	CONSTRAINT "access_credential_blocked_shape" CHECK (("wms"."access_credential"."blocked_at" is null) = ("wms"."access_credential"."blocked_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "wms"."site_visit" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"site_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"service_date" date NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"identification" text NOT NULL,
	"identifier_value" text,
	"credential_id" uuid,
	"property_id" uuid,
	"customer_id" uuid,
	"agreement_id" uuid,
	"outcome" text NOT NULL,
	"refusal_reason" text,
	"recorded_by" uuid,
	"note" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "site_visit_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "site_visit_source_one_of" CHECK ("wms"."site_visit"."source" in ('staff', 'gate')),
	CONSTRAINT "site_visit_identification_one_of" CHECK ("wms"."site_visit"."identification" in ('plate', 'card', 'property')),
	CONSTRAINT "site_visit_outcome_one_of" CHECK ("wms"."site_visit"."outcome" in ('admitted', 'refused')),
	CONSTRAINT "site_visit_refusal_reason_one_of" CHECK ("wms"."site_visit"."refusal_reason" in ('unknown-identifier', 'not-fee-paying', 'credential-blocked')),
	CONSTRAINT "site_visit_outcome_shape" CHECK (("wms"."site_visit"."outcome" = 'refused') = ("wms"."site_visit"."refusal_reason" is not null)),
	CONSTRAINT "site_visit_identifier_shape" CHECK (("wms"."site_visit"."identification" = 'property') = ("wms"."site_visit"."identifier_value" is null)),
	CONSTRAINT "site_visit_source_shape" CHECK (case "wms"."site_visit"."source" when 'staff' then "wms"."site_visit"."recorded_by" is not null and "wms"."site_visit"."external_id" is null else "wms"."site_visit"."recorded_by" is null end),
	CONSTRAINT "site_visit_holder_shape" CHECK (not ("wms"."site_visit"."property_id" is not null and "wms"."site_visit"."customer_id" is not null) and ("wms"."site_visit"."customer_id" is null or "wms"."site_visit"."agreement_id" is not null) and ("wms"."site_visit"."outcome" <> 'admitted' or "wms"."site_visit"."agreement_id" is not null)),
	CONSTRAINT "site_visit_void_shape" CHECK (("wms"."site_visit"."voided_at" is null) = ("wms"."site_visit"."void_reason" is null) and ("wms"."site_visit"."voided_by" is null or "wms"."site_visit"."voided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."site_visit_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visit_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "site_visit_fraction_membership_key" UNIQUE("company_id","visit_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."visit_rule" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"free_visits" integer DEFAULT 0 NOT NULL,
	"business_visit_product_id" uuid,
	"annual_access_product_id" uuid,
	"trade_threshold" integer,
	"trade_window_days" integer,
	CONSTRAINT "visit_rule_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "visit_rule_validity" CHECK ("wms"."visit_rule"."valid_to" is null or "wms"."visit_rule"."valid_to" > "wms"."visit_rule"."valid_from"),
	CONSTRAINT "visit_rule_free_visits_range" CHECK ("wms"."visit_rule"."free_visits" between 0 and 366),
	CONSTRAINT "visit_rule_trade_shape" CHECK (("wms"."visit_rule"."trade_threshold" is null) = ("wms"."visit_rule"."trade_window_days" is null) and ("wms"."visit_rule"."trade_threshold" is null or "wms"."visit_rule"."trade_threshold" between 1 and 1000) and ("wms"."visit_rule"."trade_window_days" is null or "wms"."visit_rule"."trade_window_days" between 1 and 366))
);
--> statement-breakpoint
CREATE TABLE "wms"."visit_rule_free_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "visit_rule_free_fraction_membership_key" UNIQUE("company_id","rule_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."visit_rule_step" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "visit_rule_step_rule_position_key" UNIQUE("company_id","rule_id","position"),
	CONSTRAINT "visit_rule_step_position_positive" CHECK ("wms"."visit_rule_step"."position" > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."product" DROP CONSTRAINT "product_unit_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_cancel_reason_one_of";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" DROP CONSTRAINT "billable_event_kind_shape";--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD COLUMN "visit_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_site_id_fk" FOREIGN KEY ("company_id","project_id","site_id") REFERENCES "wms"."drop_off_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_credential_id_fk" FOREIGN KEY ("company_id","project_id","credential_id") REFERENCES "wms"."access_credential"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ADD CONSTRAINT "site_visit_voided_by_fk" FOREIGN KEY ("company_id","voided_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit_fraction" ADD CONSTRAINT "site_visit_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit_fraction" ADD CONSTRAINT "site_visit_fraction_visit_id_fk" FOREIGN KEY ("company_id","project_id","visit_id") REFERENCES "wms"."site_visit"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."site_visit_fraction" ADD CONSTRAINT "site_visit_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ADD CONSTRAINT "visit_rule_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ADD CONSTRAINT "visit_rule_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ADD CONSTRAINT "visit_rule_business_visit_product_id_fk" FOREIGN KEY ("company_id","project_id","business_visit_product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ADD CONSTRAINT "visit_rule_annual_access_product_id_fk" FOREIGN KEY ("company_id","project_id","annual_access_product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_free_fraction" ADD CONSTRAINT "visit_rule_free_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_free_fraction" ADD CONSTRAINT "visit_rule_free_fraction_rule_id_fk" FOREIGN KEY ("company_id","project_id","rule_id") REFERENCES "wms"."visit_rule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_free_fraction" ADD CONSTRAINT "visit_rule_free_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_step" ADD CONSTRAINT "visit_rule_step_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_step" ADD CONSTRAINT "visit_rule_step_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_step" ADD CONSTRAINT "visit_rule_step_rule_id_fk" FOREIGN KEY ("company_id","project_id","rule_id") REFERENCES "wms"."visit_rule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_step" ADD CONSTRAINT "visit_rule_step_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_credential_customer_id_idx" ON "wms"."access_credential" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "access_credential_agreement_id_idx" ON "wms"."access_credential" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "access_credential_property_id_idx" ON "wms"."access_credential" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_visit_external_id_idx" ON "wms"."site_visit" USING btree ("company_id","source","external_id") WHERE "wms"."site_visit"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "site_visit_project_id_service_date_idx" ON "wms"."site_visit" USING btree ("company_id","project_id","service_date");--> statement-breakpoint
CREATE INDEX "site_visit_site_id_idx" ON "wms"."site_visit" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE INDEX "site_visit_property_id_service_date_idx" ON "wms"."site_visit" USING btree ("company_id","property_id","service_date");--> statement-breakpoint
CREATE INDEX "site_visit_customer_id_idx" ON "wms"."site_visit" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "site_visit_credential_id_idx" ON "wms"."site_visit" USING btree ("company_id","credential_id");--> statement-breakpoint
CREATE INDEX "site_visit_agreement_id_idx" ON "wms"."site_visit" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "site_visit_recorded_by_idx" ON "wms"."site_visit" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "site_visit_voided_by_idx" ON "wms"."site_visit" USING btree ("company_id","voided_by");--> statement-breakpoint
CREATE INDEX "site_visit_fraction_waste_fraction_id_idx" ON "wms"."site_visit_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "visit_rule_project_id_idx" ON "wms"."visit_rule" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "visit_rule_business_visit_product_id_idx" ON "wms"."visit_rule" USING btree ("company_id","business_visit_product_id");--> statement-breakpoint
CREATE INDEX "visit_rule_annual_access_product_id_idx" ON "wms"."visit_rule" USING btree ("company_id","annual_access_product_id");--> statement-breakpoint
CREATE INDEX "visit_rule_free_fraction_waste_fraction_id_idx" ON "wms"."visit_rule_free_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "visit_rule_step_product_id_idx" ON "wms"."visit_rule_step" USING btree ("company_id","product_id");--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_visit_id_fk" FOREIGN KEY ("company_id","project_id","visit_id") REFERENCES "wms"."site_visit"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billable_event_visit_id_idx" ON "wms"."billable_event" USING btree ("company_id","visit_id");--> statement-breakpoint
ALTER TABLE "wms"."product" ADD CONSTRAINT "product_unit_one_of" CHECK ("wms"."product"."unit" in ('pickup', 'month', 'job', 'day', 'visit'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK ("wms"."outbox_event"."kind" in ('route-dispatched', 'route-started', 'route-completed', 'route-cancelled', 'route-reassigned', 'pickup-completed', 'pickup-failed', 'pickup-skipped', 'pickup-problem-reported', 'pickup-corrected', 'unload-recorded', 'command-rejected', 'ticket-opened', 'ticket-completed', 'ticket-rejected', 'invoice-issued', 'settlement-closed', 'application-decided', 'site-visit-recorded', 'site-visit-voided'));--> statement-breakpoint
ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK ("wms"."outbox_event"."aggregate_kind" in ('route', 'pickup', 'unload', 'command', 'ticket', 'invoice', 'settlement', 'application', 'site-visit'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_visit_shape" CHECK ("wms"."billable_event"."visit_id" is null or "wms"."billable_event"."kind" = 'visit');--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_one_of" CHECK ("wms"."billable_event"."kind" in ('pickup', 'ticket', 'manual', 'reversal', 'subscription', 'job', 'hire', 'pickup-exception', 'visit'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_cancel_reason_one_of" CHECK ("wms"."billable_event"."cancel_reason" in ('pickup-corrected', 'visit-voided', 'duplicate', 'not-delivered', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_kind_shape" CHECK (case "wms"."billable_event"."kind" when 'pickup' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'ticket' then "wms"."billable_event"."ticket_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'manual' then "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null and "wms"."billable_event"."created_by" is not null when 'reversal' then "wms"."billable_event"."reverses_event_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."net_minor" is not null and "wms"."billable_event"."net_minor" <= 0 when 'subscription' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'job' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'hire' then "wms"."billable_event"."subscription_id" is not null and "wms"."billable_event"."placement_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'pickup-exception' then "wms"."billable_event"."pickup_id" is not null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null when 'visit' then "wms"."billable_event"."visit_id" is not null and "wms"."billable_event"."pickup_id" is null and "wms"."billable_event"."ticket_id" is null and "wms"."billable_event"."reverses_event_id" is null else false end);
--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "access_credential_tenant_fence" ON "wms"."access_credential" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "access_credential_touch_updated_at" BEFORE UPDATE ON "wms"."access_credential" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."site_visit" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "site_visit_tenant_fence" ON "wms"."site_visit" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "site_visit_touch_updated_at" BEFORE UPDATE ON "wms"."site_visit" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."site_visit_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "site_visit_fraction_tenant_fence" ON "wms"."site_visit_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "site_visit_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."site_visit_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "visit_rule_tenant_fence" ON "wms"."visit_rule" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "visit_rule_touch_updated_at" BEFORE UPDATE ON "wms"."visit_rule" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_step" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "visit_rule_step_tenant_fence" ON "wms"."visit_rule_step" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "visit_rule_step_touch_updated_at" BEFORE UPDATE ON "wms"."visit_rule_step" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."visit_rule_free_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "visit_rule_free_fraction_tenant_fence" ON "wms"."visit_rule_free_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "visit_rule_free_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."visit_rule_free_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."access_credential" ADD CONSTRAINT "access_credential_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "kind" WITH =, "value" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."visit_rule" ADD CONSTRAINT "visit_rule_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "access_credential_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."access_credential" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "site_visit_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."site_visit" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "site_visit_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."site_visit_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('site_visit', 'visit_id');
--> statement-breakpoint
CREATE TRIGGER "visit_rule_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."visit_rule" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "visit_rule_step_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."visit_rule_step" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('visit_rule', 'rule_id');
--> statement-breakpoint
CREATE TRIGGER "visit_rule_free_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."visit_rule_free_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('visit_rule', 'rule_id');
