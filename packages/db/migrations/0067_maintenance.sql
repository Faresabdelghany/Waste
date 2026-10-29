-- Vehicle maintenance plans (O20 of #290): a vehicle's service intervals by
-- days, kilometres or engine hours from its last service
-- (`vehicle_maintenance_plan`), the Maintenance Orders that do the work
-- (`maintenance_order`, keyed into a plan of the same vehicle), and the
-- alert's rule grown by `maintenance-due`, the worker's sixth. Below
-- drizzle-kit's statements: each table's fence, trigger and audit trail. No
-- row present changes meaning: no alert holds the new rule yet.
CREATE TABLE "wms"."maintenance_order" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"plan_id" uuid,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"due_on" date,
	"note" text,
	"completed_on" date,
	"odometer_km" integer,
	"engine_hours" integer,
	"closing_note" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "maintenance_order_status_one_of" CHECK ("wms"."maintenance_order"."status" in ('open', 'completed', 'cancelled')),
	CONSTRAINT "maintenance_order_readings_range" CHECK (("wms"."maintenance_order"."odometer_km" is null or "wms"."maintenance_order"."odometer_km" >= 0) and ("wms"."maintenance_order"."engine_hours" is null or "wms"."maintenance_order"."engine_hours" >= 0)),
	CONSTRAINT "maintenance_order_closing_shape" CHECK (("wms"."maintenance_order"."status" = 'open') = ("wms"."maintenance_order"."closed_at" is null) and ("wms"."maintenance_order"."status" = 'completed') = ("wms"."maintenance_order"."completed_on" is not null) and ("wms"."maintenance_order"."status" = 'completed' or ("wms"."maintenance_order"."odometer_km" is null and "wms"."maintenance_order"."engine_hours" is null)))
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_maintenance_plan" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"interval_days" integer,
	"interval_km" integer,
	"interval_hours" integer,
	"last_done_on" date NOT NULL,
	"last_done_km" integer,
	"last_done_hours" integer,
	"status" text NOT NULL,
	CONSTRAINT "vehicle_maintenance_plan_vehicle_id_project_key" UNIQUE("company_id","project_id","vehicle_id","id"),
	CONSTRAINT "vehicle_maintenance_plan_status_one_of" CHECK ("wms"."vehicle_maintenance_plan"."status" in ('active', 'retired')),
	CONSTRAINT "vehicle_maintenance_plan_intervals_range" CHECK (("wms"."vehicle_maintenance_plan"."interval_days" is null or "wms"."vehicle_maintenance_plan"."interval_days" between 1 and 3650) and ("wms"."vehicle_maintenance_plan"."interval_km" is null or "wms"."vehicle_maintenance_plan"."interval_km" between 1 and 2000000) and ("wms"."vehicle_maintenance_plan"."interval_hours" is null or "wms"."vehicle_maintenance_plan"."interval_hours" between 1 and 100000) and ("wms"."vehicle_maintenance_plan"."last_done_km" is null or "wms"."vehicle_maintenance_plan"."last_done_km" >= 0) and ("wms"."vehicle_maintenance_plan"."last_done_hours" is null or "wms"."vehicle_maintenance_plan"."last_done_hours" >= 0)),
	CONSTRAINT "vehicle_maintenance_plan_shape" CHECK (("wms"."vehicle_maintenance_plan"."interval_days" is not null or "wms"."vehicle_maintenance_plan"."interval_km" is not null or "wms"."vehicle_maintenance_plan"."interval_hours" is not null) and ("wms"."vehicle_maintenance_plan"."interval_km" is null or "wms"."vehicle_maintenance_plan"."last_done_km" is not null) and ("wms"."vehicle_maintenance_plan"."interval_hours" is null or "wms"."vehicle_maintenance_plan"."last_done_hours" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_vehicle_id_plan_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id","plan_id") REFERENCES "wms"."vehicle_maintenance_plan"("company_id","project_id","vehicle_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ADD CONSTRAINT "maintenance_order_closed_by_fk" FOREIGN KEY ("company_id","closed_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_maintenance_plan" ADD CONSTRAINT "vehicle_maintenance_plan_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_maintenance_plan" ADD CONSTRAINT "vehicle_maintenance_plan_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_maintenance_plan" ADD CONSTRAINT "vehicle_maintenance_plan_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_order_vehicle_id_idx" ON "wms"."maintenance_order" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "maintenance_order_project_id_idx" ON "wms"."maintenance_order" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "maintenance_order_plan_id_idx" ON "wms"."maintenance_order" USING btree ("company_id","plan_id");--> statement-breakpoint
CREATE INDEX "maintenance_order_closed_by_idx" ON "wms"."maintenance_order" USING btree ("company_id","closed_by");--> statement-breakpoint
CREATE INDEX "vehicle_maintenance_plan_project_id_idx" ON "wms"."vehicle_maintenance_plan" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK ("wms"."alert"."rule" in ('route-not-started', 'session-silent', 'licence-expiring', 'ticket-overdue', 'position-stale', 'maintenance-due'));
--> statement-breakpoint
ALTER TABLE "wms"."maintenance_order" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "maintenance_order_tenant_fence" ON "wms"."maintenance_order" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_maintenance_plan" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_maintenance_plan_tenant_fence" ON "wms"."vehicle_maintenance_plan" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "maintenance_order_touch_updated_at" BEFORE UPDATE ON "wms"."maintenance_order" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "vehicle_maintenance_plan_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_maintenance_plan" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "vehicle_maintenance_plan_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_maintenance_plan" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle', 'vehicle_id');
--> statement-breakpoint
CREATE TRIGGER "maintenance_order_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."maintenance_order" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle', 'vehicle_id');
