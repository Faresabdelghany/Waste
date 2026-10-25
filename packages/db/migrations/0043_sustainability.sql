CREATE TABLE "wms"."waste_fraction_emission_factor" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	"footprint_kg_per_tonne" integer NOT NULL,
	"avoided_kg_per_tonne" integer,
	"source" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	CONSTRAINT "waste_fraction_emission_factor_footprint_bounds" CHECK ("wms"."waste_fraction_emission_factor"."footprint_kg_per_tonne" between 0 and 10000),
	CONSTRAINT "waste_fraction_emission_factor_avoided_bounds" CHECK ("wms"."waste_fraction_emission_factor"."avoided_kg_per_tonne" between 0 and 10000),
	CONSTRAINT "waste_fraction_emission_factor_source_given" CHECK (length(btrim("wms"."waste_fraction_emission_factor"."source")) > 0),
	CONSTRAINT "waste_fraction_emission_factor_validity" CHECK ("wms"."waste_fraction_emission_factor"."valid_to" is null or "wms"."waste_fraction_emission_factor"."valid_to" > "wms"."waste_fraction_emission_factor"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD COLUMN "treatment" text;--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction_emission_factor" ADD CONSTRAINT "waste_fraction_emission_factor_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction_emission_factor" ADD CONSTRAINT "waste_fraction_emission_factor_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waste_fraction_emission_factor_waste_fraction_id_idx" ON "wms"."waste_fraction_emission_factor" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_treatment_one_of" CHECK ("wms"."waste_fraction"."treatment" in ('reuse', 'recycling', 'energy-recovery', 'disposal'));--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction_emission_factor" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "waste_fraction_emission_factor_tenant_fence" ON "wms"."waste_fraction_emission_factor" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "waste_fraction_emission_factor_touch_updated_at" BEFORE UPDATE ON "wms"."waste_fraction_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction_emission_factor" ADD CONSTRAINT "waste_fraction_emission_factor_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "waste_fraction_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "waste_fraction_emission_factor_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."waste_fraction_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
