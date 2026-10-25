CREATE TABLE "wms"."fuel_emission_factor" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fuel" text NOT NULL,
	"grams_per_unit" integer NOT NULL,
	"source" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	CONSTRAINT "fuel_emission_factor_fuel_one_of" CHECK ("wms"."fuel_emission_factor"."fuel" in ('diesel', 'hvo', 'biogas', 'electric', 'hybrid', 'other')),
	CONSTRAINT "fuel_emission_factor_grams_per_unit_bounds" CHECK ("wms"."fuel_emission_factor"."grams_per_unit" between 0 and 10000),
	CONSTRAINT "fuel_emission_factor_source_given" CHECK (length(btrim("wms"."fuel_emission_factor"."source")) > 0),
	CONSTRAINT "fuel_emission_factor_validity" CHECK ("wms"."fuel_emission_factor"."valid_to" is null or "wms"."fuel_emission_factor"."valid_to" > "wms"."fuel_emission_factor"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_type_consumption" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_type_id" uuid NOT NULL,
	"fuel" text NOT NULL,
	"milli_units_per_km" integer NOT NULL,
	CONSTRAINT "vehicle_type_consumption_type_fuel_key" UNIQUE("company_id","vehicle_type_id","fuel"),
	CONSTRAINT "vehicle_type_consumption_fuel_one_of" CHECK ("wms"."vehicle_type_consumption"."fuel" in ('diesel', 'hvo', 'biogas', 'electric', 'hybrid', 'other')),
	CONSTRAINT "vehicle_type_consumption_milli_units_per_km_bounds" CHECK ("wms"."vehicle_type_consumption"."milli_units_per_km" between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "wms"."fuel_emission_factor" ADD CONSTRAINT "fuel_emission_factor_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_type_consumption" ADD CONSTRAINT "vehicle_type_consumption_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_type_consumption" ADD CONSTRAINT "vehicle_type_consumption_vehicle_type_id_fk" FOREIGN KEY ("company_id","vehicle_type_id") REFERENCES "wms"."vehicle_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."fuel_emission_factor" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fuel_emission_factor_tenant_fence" ON "wms"."fuel_emission_factor" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "fuel_emission_factor_touch_updated_at" BEFORE UPDATE ON "wms"."fuel_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_type_consumption" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_type_consumption_tenant_fence" ON "wms"."vehicle_type_consumption" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_type_consumption_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_type_consumption" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."fuel_emission_factor" ADD CONSTRAINT "fuel_emission_factor_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "fuel" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "fuel_emission_factor_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."fuel_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "vehicle_type_consumption_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_type_consumption" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle_type', 'vehicle_type_id');
