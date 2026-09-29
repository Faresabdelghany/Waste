CREATE TABLE "wms"."plan" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"solver" text NOT NULL,
	"status" text DEFAULT 'calculating' NOT NULL,
	"fingerprint" text NOT NULL,
	"trip" text NOT NULL,
	"distance_metres" integer,
	"duration_seconds" integer,
	"deferred_until" timestamp with time zone,
	"failure_reason" text,
	"provider" text NOT NULL,
	"engine_version" text,
	"graph_date" date,
	CONSTRAINT "plan_route_id_project_key" UNIQUE("company_id","project_id","route_id","id"),
	CONSTRAINT "plan_solver_one_of" CHECK ("wms"."plan"."solver" in ('optimiser', 'manual', 'baseline')),
	CONSTRAINT "plan_status_one_of" CHECK ("wms"."plan"."status" in ('calculating', 'ready', 'failed')),
	CONSTRAINT "plan_trip_one_of" CHECK ("wms"."plan"."trip" in ('full', 'stops-only')),
	CONSTRAINT "plan_totals_shape" CHECK (case "wms"."plan"."status" when 'ready' then "wms"."plan"."distance_metres" is not null and "wms"."plan"."distance_metres" >= 0 and "wms"."plan"."duration_seconds" is not null and "wms"."plan"."duration_seconds" >= 0 else "wms"."plan"."distance_metres" is null and "wms"."plan"."duration_seconds" is null end),
	CONSTRAINT "plan_failure_shape" CHECK (("wms"."plan"."status" = 'failed') = ("wms"."plan"."failure_reason" is not null)),
	CONSTRAINT "plan_deferred_shape" CHECK ("wms"."plan"."deferred_until" is null or "wms"."plan"."status" = 'calculating')
);
--> statement-breakpoint
CREATE TABLE "wms"."plan_leg" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"path" geometry(LineString, 4326) NOT NULL,
	"metres" integer NOT NULL,
	"seconds" integer NOT NULL,
	CONSTRAINT "plan_leg_plan_id_position_key" UNIQUE("company_id","plan_id","position"),
	CONSTRAINT "plan_leg_position_positive" CHECK ("wms"."plan_leg"."position" > 0),
	CONSTRAINT "plan_leg_path_valid" CHECK (extensions.st_isvalid("wms"."plan_leg"."path") and not extensions.st_isempty("wms"."plan_leg"."path") and extensions.st_xmin("wms"."plan_leg"."path") >= -180 and extensions.st_xmax("wms"."plan_leg"."path") <= 180 and extensions.st_ymin("wms"."plan_leg"."path") >= -90 and extensions.st_ymax("wms"."plan_leg"."path") <= 90),
	CONSTRAINT "plan_leg_measure_shape" CHECK ("wms"."plan_leg"."metres" >= 0 and "wms"."plan_leg"."seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."plan_stop" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"pickup_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "plan_stop_plan_id_position_key" UNIQUE("company_id","plan_id","position"),
	CONSTRAINT "plan_stop_plan_id_pickup_id_key" UNIQUE("company_id","plan_id","pickup_id"),
	CONSTRAINT "plan_stop_position_positive" CHECK ("wms"."plan_stop"."position" > 0)
);
--> statement-breakpoint
ALTER TABLE "wms"."route" ADD COLUMN "active_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."plan" ADD CONSTRAINT "plan_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan" ADD CONSTRAINT "plan_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan" ADD CONSTRAINT "plan_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_leg" ADD CONSTRAINT "plan_leg_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_leg" ADD CONSTRAINT "plan_leg_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_leg" ADD CONSTRAINT "plan_leg_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_leg" ADD CONSTRAINT "plan_leg_route_id_plan_id_fk" FOREIGN KEY ("company_id","project_id","route_id","plan_id") REFERENCES "wms"."plan"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_route_id_plan_id_fk" FOREIGN KEY ("company_id","project_id","route_id","plan_id") REFERENCES "wms"."plan"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_fingerprint_idx" ON "wms"."plan" USING btree ("company_id","fingerprint");--> statement-breakpoint
CREATE INDEX "plan_stop_pickup_id_idx" ON "wms"."plan_stop" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "route_active_plan_id_idx" ON "wms"."route" USING btree ("company_id","active_plan_id");--> statement-breakpoint
ALTER TABLE "wms"."plan" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "plan_tenant_fence" ON "wms"."plan" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "plan_touch_updated_at" BEFORE UPDATE ON "wms"."plan" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "plan_stop_tenant_fence" ON "wms"."plan_stop" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."plan_stop" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."plan_leg" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "plan_leg_tenant_fence" ON "wms"."plan_leg" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."plan_leg" FROM wms_api;
--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_active_plan_id_fk" FOREIGN KEY ("company_id","project_id","id","active_plan_id") REFERENCES "wms"."plan"("company_id","project_id","route_id","id") ON DELETE SET NULL ("active_plan_id");
