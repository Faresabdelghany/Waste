-- Bulky-waste booking (O11 of #290): an area's Bulky Schedule — the days it
-- collects on and the slots each has — the Bulky Bookings that take a slot,
-- with their items, and the stop that collects one: `bulky`, the office's
-- address-only stop naming its booking, one live per booking. The pickup's
-- service check is replaced with the new value, and its container shape
-- admits a bulky collection without a container; every pickup present passes
-- both, since none is bulky.
CREATE TABLE "wms"."bulky_booking" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"property_id" uuid,
	"shared_collection_point_id" uuid,
	"waste_fraction_id" uuid NOT NULL,
	"day" date NOT NULL,
	"planning_area_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"note" text,
	"booked_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "bulky_booking_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "bulky_booking_place_exactly_one" CHECK (("wms"."bulky_booking"."property_id" is not null)::int + ("wms"."bulky_booking"."shared_collection_point_id" is not null)::int = 1),
	CONSTRAINT "bulky_booking_cancel_shape" CHECK (("wms"."bulky_booking"."cancelled_at" is null) = ("wms"."bulky_booking"."cancel_reason" is null) and ("wms"."bulky_booking"."cancelled_by" is null or "wms"."bulky_booking"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "wms"."bulky_booking_item" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"booking_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "bulky_booking_item_booking_id_position_key" UNIQUE("company_id","booking_id","position"),
	CONSTRAINT "bulky_booking_item_description_given" CHECK (length(btrim("wms"."bulky_booking_item"."description")) > 0),
	CONSTRAINT "bulky_booking_item_quantity_positive" CHECK ("wms"."bulky_booking_item"."quantity" > 0),
	CONSTRAINT "bulky_booking_item_position_positive" CHECK ("wms"."bulky_booking_item"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."bulky_schedule" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"planning_area_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"service_days" text[] NOT NULL,
	"week_rotation" text,
	"holiday_policy" text NOT NULL,
	"slots_per_day" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "bulky_schedule_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "bulky_schedule_validity" CHECK ("wms"."bulky_schedule"."valid_to" is null or "wms"."bulky_schedule"."valid_to" > "wms"."bulky_schedule"."valid_from"),
	CONSTRAINT "bulky_schedule_frequency_one_of" CHECK ("wms"."bulky_schedule"."frequency" in ('daily', 'weekly', 'every-2-weeks', 'every-3-weeks', 'every-4-weeks', 'monthly')),
	CONSTRAINT "bulky_schedule_service_days_subset_of" CHECK ("wms"."bulky_schedule"."service_days" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[]),
	CONSTRAINT "bulky_schedule_service_days_non_empty" CHECK (cardinality("wms"."bulky_schedule"."service_days") > 0),
	CONSTRAINT "bulky_schedule_week_rotation_one_of" CHECK ("wms"."bulky_schedule"."week_rotation" in ('odd', 'even')),
	CONSTRAINT "bulky_schedule_holiday_policy_one_of" CHECK ("wms"."bulky_schedule"."holiday_policy" in ('shift-next', 'shift-prev', 'skip', 'collect')),
	CONSTRAINT "bulky_schedule_week_rotation_shape" CHECK (("wms"."bulky_schedule"."frequency" = 'every-2-weeks') = ("wms"."bulky_schedule"."week_rotation" is not null)),
	CONSTRAINT "bulky_schedule_slots_per_day_positive" CHECK ("wms"."bulky_schedule"."slots_per_day" > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_service_one_of";--> statement-breakpoint
ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_service_container_shape";--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD COLUMN "bulky_booking_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_customer_id_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "wms"."customer"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_agreement_id_fk" FOREIGN KEY ("company_id","project_id","agreement_id") REFERENCES "wms"."agreement"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_property_id_fk" FOREIGN KEY ("company_id","project_id","property_id") REFERENCES "wms"."property"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_schedule_id_fk" FOREIGN KEY ("company_id","project_id","schedule_id") REFERENCES "wms"."bulky_schedule"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_booked_by_fk" FOREIGN KEY ("company_id","booked_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ADD CONSTRAINT "bulky_booking_cancelled_by_fk" FOREIGN KEY ("company_id","cancelled_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking_item" ADD CONSTRAINT "bulky_booking_item_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking_item" ADD CONSTRAINT "bulky_booking_item_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking_item" ADD CONSTRAINT "bulky_booking_item_booking_id_fk" FOREIGN KEY ("company_id","project_id","booking_id") REFERENCES "wms"."bulky_booking"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_product_id_fk" FOREIGN KEY ("company_id","project_id","product_id") REFERENCES "wms"."product"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bulky_booking_schedule_id_day_idx" ON "wms"."bulky_booking" USING btree ("company_id","schedule_id","day");--> statement-breakpoint
CREATE INDEX "bulky_booking_project_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_customer_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_agreement_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","agreement_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_property_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","property_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_shared_collection_point_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_waste_fraction_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_planning_area_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","planning_area_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_product_id_idx" ON "wms"."bulky_booking" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "bulky_booking_booked_by_idx" ON "wms"."bulky_booking" USING btree ("company_id","booked_by");--> statement-breakpoint
CREATE INDEX "bulky_booking_cancelled_by_idx" ON "wms"."bulky_booking" USING btree ("company_id","cancelled_by");--> statement-breakpoint
CREATE INDEX "bulky_booking_item_project_id_idx" ON "wms"."bulky_booking_item" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "bulky_schedule_project_id_idx" ON "wms"."bulky_schedule" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "bulky_schedule_planning_area_id_idx" ON "wms"."bulky_schedule" USING btree ("company_id","planning_area_id");--> statement-breakpoint
CREATE INDEX "bulky_schedule_product_id_idx" ON "wms"."bulky_schedule" USING btree ("company_id","product_id");--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_bulky_booking_id_fk" FOREIGN KEY ("company_id","project_id","bulky_booking_id") REFERENCES "wms"."bulky_booking"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_bulky_booking_id_key" ON "wms"."pickup" USING btree ("company_id","bulky_booking_id") WHERE "wms"."pickup"."bulky_booking_id" is not null and "wms"."pickup"."status" in ('planned', 'completed');--> statement-breakpoint
CREATE INDEX "pickup_bulky_booking_id_idx" ON "wms"."pickup" USING btree ("company_id","bulky_booking_id");--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_bulky_shape" CHECK (("wms"."pickup"."service" = 'bulky') = ("wms"."pickup"."bulky_booking_id" is not null) and ("wms"."pickup"."service" <> 'bulky' or "wms"."pickup"."container_id" is null));--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_one_of" CHECK ("wms"."pickup"."service" in ('empty', 'deliver', 'remove', 'swap', 'repair', 'wash', 'bulky'));--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_container_shape" CHECK ("wms"."pickup"."service" in ('empty', 'bulky') or "wms"."pickup"."container_id" is not null);
--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "bulky_booking_tenant_fence" ON "wms"."bulky_booking" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "bulky_booking_touch_updated_at" BEFORE UPDATE ON "wms"."bulky_booking" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."bulky_booking_item" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "bulky_booking_item_tenant_fence" ON "wms"."bulky_booking_item" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "bulky_booking_item_touch_updated_at" BEFORE UPDATE ON "wms"."bulky_booking_item" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "bulky_schedule_tenant_fence" ON "wms"."bulky_schedule" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "bulky_schedule_touch_updated_at" BEFORE UPDATE ON "wms"."bulky_schedule" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."bulky_schedule" ADD CONSTRAINT "bulky_schedule_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "planning_area_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "bulky_schedule_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."bulky_schedule" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "bulky_booking_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."bulky_booking" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "bulky_booking_item_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."bulky_booking_item" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('bulky_booking', 'booking_id');
