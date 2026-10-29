-- A transfer station's haul-out (M17 of #293, row 28.3): an Unloading
-- Station may be a transfer station, which holds what is tipped there; the
-- Outbound Loads that take that material on to the receiving site, with its
-- ticket and the haul and disposal costs; and the ledger of the office's stock
-- adjustments. What a station holds is a reading over the Unloads, the loads
-- and the adjustments, and is stored nowhere.
-- drizzle-kit's statements first; then the load's fence, touch and audit
-- trail, and the adjustments' fence and revoke, a ledger's. Every existing
-- station is not a transfer station, so nothing reads stock until the office
-- says one is.
CREATE TABLE "wms"."material_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unloading_station_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"delta_kg" integer NOT NULL,
	"note" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "material_adjustment_delta_not_zero" CHECK ("wms"."material_adjustment"."delta_kg" <> 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."outbound_load" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_station_id" uuid NOT NULL,
	"to_station_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"service_provider_id" uuid,
	"vehicle_registration" text NOT NULL,
	"departed_at" timestamp with time zone NOT NULL,
	"gross_kg" integer,
	"tare_kg" integer,
	"net_kg" integer NOT NULL,
	"outbound_ticket" text,
	"receiving_ticket" text,
	"received_net_kg" integer,
	"received_at" timestamp with time zone,
	"haul_cost_minor" integer,
	"disposal_cost_minor" integer,
	"status" text NOT NULL,
	"note" text,
	CONSTRAINT "outbound_load_status_one_of" CHECK ("wms"."outbound_load"."status" in ('departed', 'received', 'reconciled', 'disputed', 'cancelled')),
	CONSTRAINT "outbound_load_gross_kg_positive" CHECK ("wms"."outbound_load"."gross_kg" > 0),
	CONSTRAINT "outbound_load_tare_kg_positive" CHECK ("wms"."outbound_load"."tare_kg" > 0),
	CONSTRAINT "outbound_load_net_kg_positive" CHECK ("wms"."outbound_load"."net_kg" > 0),
	CONSTRAINT "outbound_load_received_net_kg_positive" CHECK ("wms"."outbound_load"."received_net_kg" > 0),
	CONSTRAINT "outbound_load_stations_apart" CHECK ("wms"."outbound_load"."from_station_id" <> "wms"."outbound_load"."to_station_id"),
	CONSTRAINT "outbound_load_weights_shape" CHECK (("wms"."outbound_load"."gross_kg" is null) = ("wms"."outbound_load"."tare_kg" is null) and ("wms"."outbound_load"."gross_kg" is null or "wms"."outbound_load"."net_kg" = "wms"."outbound_load"."gross_kg" - "wms"."outbound_load"."tare_kg")),
	CONSTRAINT "outbound_load_receipt_shape" CHECK (("wms"."outbound_load"."status" in ('received', 'reconciled', 'disputed')) = ("wms"."outbound_load"."receiving_ticket" is not null) and ("wms"."outbound_load"."receiving_ticket" is null) = ("wms"."outbound_load"."received_net_kg" is null) and ("wms"."outbound_load"."receiving_ticket" is null) = ("wms"."outbound_load"."received_at" is null)),
	CONSTRAINT "outbound_load_note_shape" CHECK ("wms"."outbound_load"."status" not in ('disputed', 'cancelled') or "wms"."outbound_load"."note" is not null),
	CONSTRAINT "outbound_load_costs_not_negative" CHECK (("wms"."outbound_load"."haul_cost_minor" is null or "wms"."outbound_load"."haul_cost_minor" >= 0) and ("wms"."outbound_load"."disposal_cost_minor" is null or "wms"."outbound_load"."disposal_cost_minor" >= 0))
);
--> statement-breakpoint
ALTER TABLE "wms"."unloading_station" ADD COLUMN "transfer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ADD CONSTRAINT "material_adjustment_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ADD CONSTRAINT "material_adjustment_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ADD CONSTRAINT "material_adjustment_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ADD CONSTRAINT "material_adjustment_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ADD CONSTRAINT "material_adjustment_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_from_station_id_fk" FOREIGN KEY ("company_id","from_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_to_station_id_fk" FOREIGN KEY ("company_id","to_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ADD CONSTRAINT "outbound_load_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "material_adjustment_station_idx" ON "wms"."material_adjustment" USING btree ("company_id","unloading_station_id","waste_fraction_id","id");--> statement-breakpoint
CREATE INDEX "material_adjustment_project_id_idx" ON "wms"."material_adjustment" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "material_adjustment_waste_fraction_id_idx" ON "wms"."material_adjustment" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "material_adjustment_recorded_by_idx" ON "wms"."material_adjustment" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "outbound_load_from_station_idx" ON "wms"."outbound_load" USING btree ("company_id","from_station_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "outbound_load_to_station_id_idx" ON "wms"."outbound_load" USING btree ("company_id","to_station_id");--> statement-breakpoint
CREATE INDEX "outbound_load_waste_fraction_id_idx" ON "wms"."outbound_load" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "outbound_load_vehicle_id_idx" ON "wms"."outbound_load" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "outbound_load_service_provider_id_idx" ON "wms"."outbound_load" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "outbound_load_project_id_departed_at_idx" ON "wms"."outbound_load" USING btree ("company_id","project_id","departed_at");
--> statement-breakpoint
ALTER TABLE "wms"."outbound_load" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbound_load_tenant_fence" ON "wms"."outbound_load" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "outbound_load_touch_updated_at" BEFORE UPDATE ON "wms"."outbound_load" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "outbound_load_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."outbound_load" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
ALTER TABLE "wms"."material_adjustment" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "material_adjustment_tenant_fence" ON "wms"."material_adjustment" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."material_adjustment" FROM wms_api;
