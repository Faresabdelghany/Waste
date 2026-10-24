-- When a driver or a vehicle is not there (O6 of #290): two new tables of
-- dated periods, each a validity over days (ADR-0005) under its own
-- exclusion over the driver or the vehicle, so one period covers a day; each
-- fenced, touched and audited as a set of its driver's or vehicle's
-- (sql/audit-trail.ts, ABSENCES_AUDITED). Nothing else is altered and nothing
-- is backfilled: no absence is known before this file.
CREATE TABLE "wms"."driver_absence" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"driver_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	CONSTRAINT "driver_absence_validity" CHECK ("wms"."driver_absence"."valid_to" is null or "wms"."driver_absence"."valid_to" > "wms"."driver_absence"."valid_from"),
	CONSTRAINT "driver_absence_reason_one_of" CHECK ("wms"."driver_absence"."reason" in ('holiday', 'sick', 'training', 'leave', 'other'))
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_unavailability" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"vehicle_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	CONSTRAINT "vehicle_unavailability_validity" CHECK ("wms"."vehicle_unavailability"."valid_to" is null or "wms"."vehicle_unavailability"."valid_to" > "wms"."vehicle_unavailability"."valid_from"),
	CONSTRAINT "vehicle_unavailability_reason_one_of" CHECK ("wms"."vehicle_unavailability"."reason" in ('maintenance', 'repair', 'inspection', 'breakdown', 'other'))
);
--> statement-breakpoint
ALTER TABLE "wms"."driver_absence" ADD CONSTRAINT "driver_absence_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_absence" ADD CONSTRAINT "driver_absence_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."driver_absence" ADD CONSTRAINT "driver_absence_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_absence_project_id_valid_from_idx" ON "wms"."driver_absence" USING btree ("company_id","project_id","valid_from");--> statement-breakpoint
CREATE INDEX "vehicle_unavailability_project_id_valid_from_idx" ON "wms"."vehicle_unavailability" USING btree ("company_id","project_id","valid_from");
--> statement-breakpoint
ALTER TABLE "wms"."driver_absence" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "driver_absence_tenant_fence" ON "wms"."driver_absence" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "driver_absence_touch_updated_at" BEFORE UPDATE ON "wms"."driver_absence" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."driver_absence" ADD CONSTRAINT "driver_absence_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "driver_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_unavailability" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_unavailability_tenant_fence" ON "wms"."vehicle_unavailability" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "vehicle_unavailability_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_unavailability" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_unavailability" ADD CONSTRAINT "vehicle_unavailability_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "vehicle_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
CREATE TRIGGER "driver_absence_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."driver_absence" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('driver', 'driver_id');
--> statement-breakpoint
CREATE TRIGGER "vehicle_unavailability_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_unavailability" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle', 'vehicle_id');
