-- Pre-trip inspection (O13 of #290): a vehicle type's checklist
-- (`pre_trip_checklist_item`), the checks a driver's `pre-trip-check` appends
-- (`pre_trip_check`, a ledger), and the defects a check finds
-- (`vehicle_defect`); the driver command's kind grown by `pre-trip-check`, and
-- a ticket's kind — with the three checks that read it, an SLA's, a team
-- default's and a ticket charge's — by `vehicle-defect`. Below drizzle-kit's
-- statements: each table's fence, the ledger's revoke from the API role, the
-- two current-state tables' triggers and their audit trails. No row present
-- changes meaning: no receipt or ticket holds a new kind yet.
CREATE TABLE "wms"."pre_trip_check" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid NOT NULL,
	"device_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"defect_count" integer NOT NULL,
	"odometer_km" integer,
	"engine_hours" integer,
	"location" geometry(Point, 4326),
	"location_accuracy_m" integer,
	CONSTRAINT "pre_trip_check_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "pre_trip_check_location_valid" CHECK (extensions.st_isvalid("wms"."pre_trip_check"."location") and not extensions.st_isempty("wms"."pre_trip_check"."location") and extensions.st_xmin("wms"."pre_trip_check"."location") >= -180 and extensions.st_xmax("wms"."pre_trip_check"."location") <= 180 and extensions.st_ymin("wms"."pre_trip_check"."location") >= -90 and extensions.st_ymax("wms"."pre_trip_check"."location") <= 90),
	CONSTRAINT "pre_trip_check_location_accuracy_m_positive" CHECK ("wms"."pre_trip_check"."location_accuracy_m" > 0),
	CONSTRAINT "pre_trip_check_readings_range" CHECK ("wms"."pre_trip_check"."defect_count" >= 0 and ("wms"."pre_trip_check"."odometer_km" is null or "wms"."pre_trip_check"."odometer_km" >= 0) and ("wms"."pre_trip_check"."engine_hours" is null or "wms"."pre_trip_check"."engine_hours" >= 0))
);
--> statement-breakpoint
CREATE TABLE "wms"."pre_trip_checklist_item" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_type_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"critical" boolean NOT NULL,
	CONSTRAINT "pre_trip_checklist_item_vehicle_type_id_position_key" UNIQUE("company_id","vehicle_type_id","position"),
	CONSTRAINT "pre_trip_checklist_item_position_positive" CHECK ("wms"."pre_trip_checklist_item"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."vehicle_defect" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"pre_trip_check_id" uuid NOT NULL,
	"label" text NOT NULL,
	"critical" boolean NOT NULL,
	"note" text,
	"found_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"ticket_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	CONSTRAINT "vehicle_defect_status_one_of" CHECK ("wms"."vehicle_defect"."status" in ('open', 'resolved')),
	CONSTRAINT "vehicle_defect_resolution_shape" CHECK (("wms"."vehicle_defect"."status" = 'resolved') = ("wms"."vehicle_defect"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket" DROP CONSTRAINT "ticket_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" DROP CONSTRAINT "ticket_sla_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" DROP CONSTRAINT "ticket_team_default_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" DROP CONSTRAINT "ticket_kind_product_ticket_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ADD CONSTRAINT "pre_trip_check_recorded_by_fk" FOREIGN KEY ("company_id","recorded_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_checklist_item" ADD CONSTRAINT "pre_trip_checklist_item_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_checklist_item" ADD CONSTRAINT "pre_trip_checklist_item_vehicle_type_id_fk" FOREIGN KEY ("company_id","vehicle_type_id") REFERENCES "wms"."vehicle_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_pre_trip_check_id_fk" FOREIGN KEY ("company_id","project_id","pre_trip_check_id") REFERENCES "wms"."pre_trip_check"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ADD CONSTRAINT "vehicle_defect_resolved_by_fk" FOREIGN KEY ("company_id","resolved_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pre_trip_check_vehicle_id_idx" ON "wms"."pre_trip_check" USING btree ("company_id","vehicle_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pre_trip_check_project_id_idx" ON "wms"."pre_trip_check" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "pre_trip_check_route_id_idx" ON "wms"."pre_trip_check" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "pre_trip_check_driver_id_idx" ON "wms"."pre_trip_check" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "pre_trip_check_recorded_by_idx" ON "wms"."pre_trip_check" USING btree ("company_id","recorded_by");--> statement-breakpoint
CREATE INDEX "vehicle_defect_vehicle_id_idx" ON "wms"."vehicle_defect" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "vehicle_defect_project_id_idx" ON "wms"."vehicle_defect" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "vehicle_defect_pre_trip_check_id_idx" ON "wms"."vehicle_defect" USING btree ("company_id","pre_trip_check_id");--> statement-breakpoint
CREATE INDEX "vehicle_defect_ticket_id_idx" ON "wms"."vehicle_defect" USING btree ("company_id","ticket_id");--> statement-breakpoint
CREATE INDEX "vehicle_defect_resolved_by_idx" ON "wms"."vehicle_defect" USING btree ("company_id","resolved_by");--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route', 'record-positions', 'pre-trip-check'));--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_kind_one_of" CHECK ("wms"."ticket"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'vehicle-defect', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_sla" ADD CONSTRAINT "ticket_sla_kind_one_of" CHECK ("wms"."ticket_sla"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'vehicle-defect', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_kind_one_of" CHECK ("wms"."ticket_team_default"."kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'vehicle-defect', 'other'));--> statement-breakpoint
ALTER TABLE "wms"."ticket_kind_product" ADD CONSTRAINT "ticket_kind_product_ticket_kind_one_of" CHECK ("wms"."ticket_kind_product"."ticket_kind" in ('missed-collection', 'overflow', 'access-issue', 'container-request', 'container-defect', 'proof-follow-up', 'complaint', 'reported-problem', 'rejected-command', 'internal-task', 'vehicle-defect', 'other'));
--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_check" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pre_trip_check_tenant_fence" ON "wms"."pre_trip_check" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."pre_trip_checklist_item" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "pre_trip_checklist_item_tenant_fence" ON "wms"."pre_trip_checklist_item" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
ALTER TABLE "wms"."vehicle_defect" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "vehicle_defect_tenant_fence" ON "wms"."vehicle_defect" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."pre_trip_check" FROM wms_api;
--> statement-breakpoint
CREATE TRIGGER "pre_trip_checklist_item_touch_updated_at" BEFORE UPDATE ON "wms"."pre_trip_checklist_item" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "vehicle_defect_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_defect" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "pre_trip_checklist_item_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."pre_trip_checklist_item" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle_type', 'vehicle_type_id');
--> statement-breakpoint
CREATE TRIGGER "vehicle_defect_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_defect" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle', 'vehicle_id');
