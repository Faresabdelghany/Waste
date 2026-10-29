-- Fill-level Sensors (O26 of #290, row 9.10): a company's sensors, their
-- pairings with the containers they measure, and the ledger of the readings
-- the vendor-neutral ingest appends; and the alert rule `fill-threshold`.
-- drizzle-kit's statements first; then the sensor's and the pairing's fences,
-- touches and audit trails, the pairing's two exclusion constraints (one
-- container per sensor at a time, one sensor per container at a time), and
-- the readings' fence and revoke, a ledger's. No row holds the new rule yet.
CREATE TABLE "wms"."fill_reading" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensor_id" uuid NOT NULL,
	"pairing_id" uuid,
	"measured_at" timestamp with time zone NOT NULL,
	"fill_percent" integer NOT NULL,
	"battery_percent" integer,
	"rssi_dbm" integer,
	CONSTRAINT "fill_reading_sensor_id_measured_at_key" UNIQUE("company_id","sensor_id","measured_at"),
	CONSTRAINT "fill_reading_fill_range" CHECK ("wms"."fill_reading"."fill_percent" between 0 and 100),
	CONSTRAINT "fill_reading_battery_range" CHECK ("wms"."fill_reading"."battery_percent" is null or "wms"."fill_reading"."battery_percent" between 0 and 100),
	CONSTRAINT "fill_reading_rssi_range" CHECK ("wms"."fill_reading"."rssi_dbm" is null or "wms"."fill_reading"."rssi_dbm" between -200 and 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."sensor" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"identifier" text NOT NULL,
	"network" text NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "sensor_identifier_key" UNIQUE("company_id","identifier"),
	CONSTRAINT "sensor_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "sensor_network_one_of" CHECK ("wms"."sensor"."network" in ('lorawan', 'sigfox', 'nb-iot')),
	CONSTRAINT "sensor_status_one_of" CHECK ("wms"."sensor"."status" in ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "wms"."sensor_pairing" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"sensor_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"full_threshold_percent" integer NOT NULL,
	CONSTRAINT "sensor_pairing_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "sensor_pairing_validity" CHECK ("wms"."sensor_pairing"."valid_to" is null or "wms"."sensor_pairing"."valid_to" > "wms"."sensor_pairing"."valid_from"),
	CONSTRAINT "sensor_pairing_threshold_range" CHECK ("wms"."sensor_pairing"."full_threshold_percent" between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";--> statement-breakpoint
ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_sensor_id_fk" FOREIGN KEY ("company_id","project_id","sensor_id") REFERENCES "wms"."sensor"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_pairing_id_fk" FOREIGN KEY ("company_id","project_id","pairing_id") REFERENCES "wms"."sensor_pairing"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor" ADD CONSTRAINT "sensor_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor" ADD CONSTRAINT "sensor_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_sensor_id_fk" FOREIGN KEY ("company_id","project_id","sensor_id") REFERENCES "wms"."sensor"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fill_reading_pairing_id_idx" ON "wms"."fill_reading" USING btree ("company_id","pairing_id","measured_at");--> statement-breakpoint
CREATE INDEX "fill_reading_project_id_idx" ON "wms"."fill_reading" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK ("wms"."alert"."rule" in ('route-not-started', 'session-silent', 'licence-expiring', 'ticket-overdue', 'position-stale', 'fill-threshold'));
--> statement-breakpoint
ALTER TABLE "wms"."sensor" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sensor_tenant_fence" ON "wms"."sensor" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "sensor_touch_updated_at" BEFORE UPDATE ON "wms"."sensor" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "sensor_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."sensor" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "sensor_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_container_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."sensor_pairing" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sensor_pairing_tenant_fence" ON "wms"."sensor_pairing" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "sensor_pairing_touch_updated_at" BEFORE UPDATE ON "wms"."sensor_pairing" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "sensor_pairing_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."sensor_pairing" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('sensor', 'sensor_id');
--> statement-breakpoint
ALTER TABLE "wms"."fill_reading" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fill_reading_tenant_fence" ON "wms"."fill_reading" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."fill_reading" FROM wms_api;
