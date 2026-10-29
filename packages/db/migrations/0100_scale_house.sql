-- The scale house (M16a of #293, #404): the tare register (`vehicle_tare`),
-- the window's tickets weighed at our own sites (`scale_ticket`) and the
-- ledger of a completed ticket's split by fraction and origin
-- (`scale_ticket_line`), and the company's scale-ticket counter.
-- drizzle-kit's statements first; then the tare's and the ticket's fences,
-- touches and audit trails, and the lines' fence and revoke, a ledger's. New
-- tables and a counter defaulting where the others start, so no row present
-- changes meaning.
CREATE TABLE "wms"."scale_ticket" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"number" integer NOT NULL,
	"unloading_station_id" uuid NOT NULL,
	"vehicle_plate" text NOT NULL,
	"trailer_plate" text,
	"container_ref" text,
	"vehicle_id" uuid,
	"party" text NOT NULL,
	"customer_id" uuid,
	"agreement_id" uuid,
	"visitor_name" text,
	"gross_kg" integer NOT NULL,
	"weighed_in_at" timestamp with time zone NOT NULL,
	"tare_kg" integer,
	"tare_source" text,
	"vehicle_tare_id" uuid,
	"weighed_out_at" timestamp with time zone,
	"net_kg" integer,
	"status" text NOT NULL,
	"route_id" uuid,
	"unload_id" uuid,
	"unmatched_reason" text,
	"void_reason" text,
	"void_note" text,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"note" text,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "scale_ticket_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "scale_ticket_number_key" UNIQUE("company_id","number"),
	CONSTRAINT "scale_ticket_party_one_of" CHECK ("wms"."scale_ticket"."party" in ('account', 'cash')),
	CONSTRAINT "scale_ticket_status_one_of" CHECK ("wms"."scale_ticket"."status" in ('open', 'completed', 'voided')),
	CONSTRAINT "scale_ticket_tare_source_one_of" CHECK ("wms"."scale_ticket"."tare_source" in ('weighed', 'registered')),
	CONSTRAINT "scale_ticket_void_reason_one_of" CHECK ("wms"."scale_ticket"."void_reason" in ('entered-in-error', 'duplicate', 'visitor-left', 'other')),
	CONSTRAINT "scale_ticket_unmatched_reason_one_of" CHECK ("wms"."scale_ticket"."unmatched_reason" in ('unknown-vehicle', 'no-route', 'several-routes', 'unknown-fraction', 'fraction-not-accepted')),
	CONSTRAINT "scale_ticket_gross_kg_positive" CHECK ("wms"."scale_ticket"."gross_kg" > 0),
	CONSTRAINT "scale_ticket_tare_kg_positive" CHECK ("wms"."scale_ticket"."tare_kg" > 0),
	CONSTRAINT "scale_ticket_net_kg_positive" CHECK ("wms"."scale_ticket"."net_kg" > 0),
	CONSTRAINT "scale_ticket_party_shape" CHECK (case when "wms"."scale_ticket"."party" = 'account' then "wms"."scale_ticket"."customer_id" is not null and "wms"."scale_ticket"."agreement_id" is not null else "wms"."scale_ticket"."customer_id" is null and "wms"."scale_ticket"."agreement_id" is null end),
	CONSTRAINT "scale_ticket_weighing_shape" CHECK (("wms"."scale_ticket"."tare_kg" is null) = ("wms"."scale_ticket"."tare_source" is null) and ("wms"."scale_ticket"."tare_kg" is null) = ("wms"."scale_ticket"."weighed_out_at" is null) and ("wms"."scale_ticket"."tare_kg" is null) = ("wms"."scale_ticket"."net_kg" is null) and ("wms"."scale_ticket"."net_kg" is null or "wms"."scale_ticket"."net_kg" = "wms"."scale_ticket"."gross_kg" - "wms"."scale_ticket"."tare_kg") and ("wms"."scale_ticket"."tare_source" is not distinct from 'registered') = ("wms"."scale_ticket"."vehicle_tare_id" is not null) and ("wms"."scale_ticket"."status" <> 'open' or "wms"."scale_ticket"."tare_kg" is null) and ("wms"."scale_ticket"."status" <> 'completed' or "wms"."scale_ticket"."tare_kg" is not null)),
	CONSTRAINT "scale_ticket_void_shape" CHECK (("wms"."scale_ticket"."status" = 'voided') = ("wms"."scale_ticket"."void_reason" is not null) and ("wms"."scale_ticket"."void_reason" is null) = ("wms"."scale_ticket"."voided_at" is null) and ("wms"."scale_ticket"."void_reason" is null) = ("wms"."scale_ticket"."voided_by" is null) and ("wms"."scale_ticket"."void_reason" <> 'other' or "wms"."scale_ticket"."void_note" is not null)),
	CONSTRAINT "scale_ticket_match_shape" CHECK (("wms"."scale_ticket"."route_id" is null) = ("wms"."scale_ticket"."unload_id" is null) and ("wms"."scale_ticket"."unload_id" is null or ("wms"."scale_ticket"."vehicle_id" is not null and "wms"."scale_ticket"."tare_kg" is not null)) and ("wms"."scale_ticket"."unmatched_reason" is null or ("wms"."scale_ticket"."vehicle_id" is not null and "wms"."scale_ticket"."tare_kg" is not null and "wms"."scale_ticket"."unload_id" is null)))
);
--> statement-breakpoint
CREATE TABLE "wms"."scale_ticket_line" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"origin_municipality" text,
	"net_kg" integer NOT NULL,
	CONSTRAINT "scale_ticket_line_ticket_id_position_key" UNIQUE("company_id","ticket_id","position"),
	CONSTRAINT "scale_ticket_line_position_positive" CHECK ("wms"."scale_ticket_line"."position" > 0),
	CONSTRAINT "scale_ticket_line_net_kg_positive" CHECK ("wms"."scale_ticket_line"."net_kg" > 0),
	CONSTRAINT "scale_ticket_line_origin_shape" CHECK ("wms"."scale_ticket_line"."origin_municipality" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_tare" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plate" text NOT NULL,
	"trailer_plate" text,
	"container_ref" text,
	"tare_kg" integer NOT NULL,
	"weighed_on" date NOT NULL,
	"customer_id" uuid,
	"label" text,
	"status" text NOT NULL,
	CONSTRAINT "vehicle_tare_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "vehicle_tare_status_one_of" CHECK ("wms"."vehicle_tare"."status" in ('active', 'retired')),
	CONSTRAINT "vehicle_tare_tare_kg_positive" CHECK ("wms"."vehicle_tare"."tare_kg" > 0),
	CONSTRAINT "vehicle_tare_key_shape" CHECK (("wms"."vehicle_tare"."plate" <> '' and "wms"."vehicle_tare"."plate" = upper("wms"."vehicle_tare"."plate") and "wms"."vehicle_tare"."plate" !~ '[[:space:][:punct:]]') and ("wms"."vehicle_tare"."trailer_plate" is null or ("wms"."vehicle_tare"."trailer_plate" <> '' and "wms"."vehicle_tare"."trailer_plate" = upper("wms"."vehicle_tare"."trailer_plate") and "wms"."vehicle_tare"."trailer_plate" !~ '[[:space:][:punct:]]')) and ("wms"."vehicle_tare"."container_ref" is null or ("wms"."vehicle_tare"."container_ref" <> '' and "wms"."vehicle_tare"."container_ref" = upper("wms"."vehicle_tare"."container_ref") and "wms"."vehicle_tare"."container_ref" !~ '[[:space:][:punct:]]')))
);
--> statement-breakpoint
ALTER TABLE "wms"."company" ADD COLUMN "next_scale_ticket_number" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_vehicle_tare_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_tare_id") REFERENCES "wms"."vehicle_tare"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_unload_id_fk" FOREIGN KEY ("company_id","project_id","unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ADD CONSTRAINT "scale_ticket_voided_by_fk" FOREIGN KEY ("company_id","voided_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."scale_ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ADD CONSTRAINT "scale_ticket_line_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_tare" ADD CONSTRAINT "vehicle_tare_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_tare" ADD CONSTRAINT "vehicle_tare_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_tare" ADD CONSTRAINT "vehicle_tare_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scale_ticket_vehicle_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_customer_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_agreement_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_vehicle_tare_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","vehicle_tare_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_route_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_unload_id_idx" ON "wms"."scale_ticket" USING btree ("company_id","unload_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_recorded_by_idx" ON "wms"."scale_ticket" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "scale_ticket_voided_by_idx" ON "wms"."scale_ticket" USING btree ("company_id","voided_by");--> statement-breakpoint
CREATE INDEX "scale_ticket_station_status_idx" ON "wms"."scale_ticket" USING btree ("company_id","unloading_station_id","status","weighed_out_at");--> statement-breakpoint
CREATE INDEX "scale_ticket_line_waste_fraction_id_idx" ON "wms"."scale_ticket_line" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "scale_ticket_line_project_id_idx" ON "wms"."scale_ticket_line" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_tare_active_key" ON "wms"."vehicle_tare" USING btree ("company_id","project_id","plate",coalesce("trailer_plate", ''),coalesce("container_ref", '')) WHERE "wms"."vehicle_tare"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vehicle_tare_customer_id_idx" ON "wms"."vehicle_tare" USING btree ("company_id","customer_id");--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "scale_ticket_tenant_fence" ON "wms"."scale_ticket" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "scale_ticket_touch_updated_at" BEFORE UPDATE ON "wms"."scale_ticket" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "scale_ticket_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."scale_ticket" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_tare" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_tare_tenant_fence" ON "wms"."vehicle_tare" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_tare_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_tare" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "vehicle_tare_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_tare" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
ALTER TABLE "wms"."scale_ticket_line" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "scale_ticket_line_tenant_fence" ON "wms"."scale_ticket_line" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."scale_ticket_line" FROM wms_api;
