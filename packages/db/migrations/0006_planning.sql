CREATE TABLE "wms"."planning_area" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	CONSTRAINT "planning_area_project_id_code_key" UNIQUE("company_id","project_id","code"),
	CONSTRAINT "planning_area_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "planning_area_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "planning_area_purpose_one_of" CHECK ("wms"."planning_area"."purpose" in ('route-planning', 'service-operations', 'notification'))
);
--> statement-breakpoint
CREATE TABLE "wms"."planning_area_boundary" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"planning_area_id" uuid NOT NULL,
	"boundary" geometry(Polygon, 4326) NOT NULL,
	CONSTRAINT "planning_area_boundary_validity" CHECK ("wms"."planning_area_boundary"."valid_to" is null or "wms"."planning_area_boundary"."valid_to" > "wms"."planning_area_boundary"."valid_from"),
	CONSTRAINT "planning_area_boundary_boundary_valid" CHECK (extensions.st_isvalid("wms"."planning_area_boundary"."boundary") and not extensions.st_isempty("wms"."planning_area_boundary"."boundary") and extensions.st_xmin("wms"."planning_area_boundary"."boundary") >= -180 and extensions.st_xmax("wms"."planning_area_boundary"."boundary") <= 180 and extensions.st_ymin("wms"."planning_area_boundary"."boundary") >= -90 and extensions.st_ymax("wms"."planning_area_boundary"."boundary") <= 90)
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_calendar" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"name" text NOT NULL,
	CONSTRAINT "collection_calendar_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "collection_calendar_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "collection_calendar_validity" CHECK ("wms"."collection_calendar"."valid_to" is null or "wms"."collection_calendar"."valid_to" > "wms"."collection_calendar"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_calendar_holiday" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_calendar_id" uuid NOT NULL,
	"day" date NOT NULL,
	"name" text,
	CONSTRAINT "collection_calendar_holiday_collection_calendar_id_day_key" UNIQUE("company_id","collection_calendar_id","day")
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_group" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_scheme_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"days" text[] NOT NULL,
	"stop_source" text NOT NULL,
	"rule_vehicle_type" text,
	"service_provider_id" uuid,
	CONSTRAINT "collection_group_route_scheme_id_name_key" UNIQUE("company_id","route_scheme_id","name"),
	CONSTRAINT "collection_group_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "collection_group_days_subset_of" CHECK ("wms"."collection_group"."days" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[]),
	CONSTRAINT "collection_group_stop_source_one_of" CHECK ("wms"."collection_group"."stop_source" in ('rule', 'manual')),
	CONSTRAINT "collection_group_rule_vehicle_type_one_of" CHECK ("wms"."collection_group"."rule_vehicle_type" in ('rear-loader', 'organic-sealed', 'paper-compactor', 'glass-crane', 'vacuum-tanker')),
	CONSTRAINT "collection_group_position_positive" CHECK ("wms"."collection_group"."position" > 0),
	CONSTRAINT "collection_group_rule_shape" CHECK ("wms"."collection_group"."stop_source" = 'rule' or "wms"."collection_group"."rule_vehicle_type" is null)
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_group_container" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_group_id" uuid NOT NULL,
	"container_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "collection_group_container_collection_group_id_container_id_key" UNIQUE("company_id","collection_group_id","container_id"),
	CONSTRAINT "collection_group_container_collection_group_id_position_key" UNIQUE("company_id","collection_group_id","position"),
	CONSTRAINT "collection_group_container_position_positive" CHECK ("wms"."collection_group_container"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_group_container_type" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_group_id" uuid NOT NULL,
	"container_type_id" uuid NOT NULL,
	CONSTRAINT "collection_group_container_type_membership_key" UNIQUE("company_id","collection_group_id","container_type_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."collection_group_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_group_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "collection_group_fraction_membership_key" UNIQUE("company_id","collection_group_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."route_scheme" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"name" text NOT NULL,
	"planning_area_id" uuid,
	"service_type" text NOT NULL,
	"frequency" text NOT NULL,
	"service_days" text[] NOT NULL,
	"week_rotation" text,
	"planned_start_time" time,
	"holiday_policy" text DEFAULT 'skip' NOT NULL,
	"edit_policy" text DEFAULT 'ask' NOT NULL,
	"plan_ahead" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	CONSTRAINT "route_scheme_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "route_scheme_validity" CHECK ("wms"."route_scheme"."valid_to" is null or "wms"."route_scheme"."valid_to" > "wms"."route_scheme"."valid_from"),
	CONSTRAINT "route_scheme_service_type_one_of" CHECK ("wms"."route_scheme"."service_type" in ('container-collection', 'underground-collection', 'kerbside-collection', 'crane-collection', 'tank-emptying')),
	CONSTRAINT "route_scheme_frequency_one_of" CHECK ("wms"."route_scheme"."frequency" in ('daily', 'weekly', 'every-2-weeks', 'every-3-weeks', 'every-4-weeks', 'monthly')),
	CONSTRAINT "route_scheme_service_days_subset_of" CHECK ("wms"."route_scheme"."service_days" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[]),
	CONSTRAINT "route_scheme_service_days_non_empty" CHECK (cardinality("wms"."route_scheme"."service_days") > 0),
	CONSTRAINT "route_scheme_week_rotation_one_of" CHECK ("wms"."route_scheme"."week_rotation" in ('odd', 'even')),
	CONSTRAINT "route_scheme_holiday_policy_one_of" CHECK ("wms"."route_scheme"."holiday_policy" in ('shift-next', 'shift-prev', 'skip', 'collect')),
	CONSTRAINT "route_scheme_edit_policy_one_of" CHECK ("wms"."route_scheme"."edit_policy" in ('ask', 'future', 'single')),
	CONSTRAINT "route_scheme_status_one_of" CHECK ("wms"."route_scheme"."status" in ('draft', 'validated')),
	CONSTRAINT "route_scheme_week_rotation_shape" CHECK (("wms"."route_scheme"."frequency" = 'every-2-weeks') = ("wms"."route_scheme"."week_rotation" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "weekend" text[] DEFAULT '{saturday,sunday}' NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."project" ADD COLUMN "holiday_list" text;--> statement-breakpoint
ALTER TABLE "wms"."planning_area" ADD CONSTRAINT "planning_area_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."planning_area" ADD CONSTRAINT "planning_area_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."planning_area_boundary" ADD CONSTRAINT "planning_area_boundary_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."planning_area_boundary" ADD CONSTRAINT "planning_area_boundary_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."planning_area_boundary" ADD CONSTRAINT "planning_area_boundary_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar" ADD CONSTRAINT "collection_calendar_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar" ADD CONSTRAINT "collection_calendar_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar_holiday" ADD CONSTRAINT "collection_calendar_holiday_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar_holiday" ADD CONSTRAINT "collection_calendar_holiday_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar_holiday" ADD CONSTRAINT "collection_calendar_holiday_collection_calendar_id_fk" FOREIGN KEY ("company_id","project_id","collection_calendar_id") REFERENCES "wms"."collection_calendar"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_service_provider_id_fk" FOREIGN KEY ("company_id","service_provider_id") REFERENCES "wms"."service_provider"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container" ADD CONSTRAINT "collection_group_container_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container" ADD CONSTRAINT "collection_group_container_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container" ADD CONSTRAINT "collection_group_container_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container" ADD CONSTRAINT "collection_group_container_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container_type" ADD CONSTRAINT "collection_group_container_type_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container_type" ADD CONSTRAINT "collection_group_container_type_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container_type" ADD CONSTRAINT "collection_group_container_type_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container_type" ADD CONSTRAINT "collection_group_container_type_container_type_id_fk" FOREIGN KEY ("company_id","container_type_id") REFERENCES "wms"."container_type"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_fraction" ADD CONSTRAINT "collection_group_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_fraction" ADD CONSTRAINT "collection_group_fraction_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_fraction" ADD CONSTRAINT "collection_group_fraction_collection_group_id_fk" FOREIGN KEY ("company_id","project_id","collection_group_id") REFERENCES "wms"."collection_group"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."collection_group_fraction" ADD CONSTRAINT "collection_group_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planning_area_boundary_project_id_idx" ON "wms"."planning_area_boundary" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "planning_area_boundary_planning_area_id_idx" ON "wms"."planning_area_boundary" USING btree ("company_id","planning_area_id");--> statement-breakpoint
CREATE INDEX "planning_area_boundary_boundary_idx" ON "wms"."planning_area_boundary" USING gist ("boundary");--> statement-breakpoint
CREATE INDEX "collection_calendar_holiday_project_id_idx" ON "wms"."collection_calendar_holiday" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "collection_group_service_provider_id_idx" ON "wms"."collection_group" USING btree ("company_id","service_provider_id");--> statement-breakpoint
CREATE INDEX "collection_group_container_project_id_idx" ON "wms"."collection_group_container" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "collection_group_container_container_id_idx" ON "wms"."collection_group_container" USING btree ("company_id","container_id");--> statement-breakpoint
CREATE INDEX "collection_group_container_type_project_id_idx" ON "wms"."collection_group_container_type" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "collection_group_container_type_container_type_id_idx" ON "wms"."collection_group_container_type" USING btree ("company_id","container_type_id");--> statement-breakpoint
CREATE INDEX "collection_group_fraction_project_id_idx" ON "wms"."collection_group_fraction" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "collection_group_fraction_waste_fraction_id_idx" ON "wms"."collection_group_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "route_scheme_planning_area_id_idx" ON "wms"."route_scheme" USING btree ("company_id","planning_area_id");--> statement-breakpoint
ALTER TABLE "wms"."project" ADD CONSTRAINT "project_weekend_subset_of" CHECK ("wms"."project"."weekend" <@ ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']::text[]);
--> statement-breakpoint
-- Hand-written from here on (migrations/README.md): the fence and the
-- updated_at trigger of each of the nine tables, table by table, then the
-- three exclusion constraints — one boundary of an area, one calendar of a
-- project and one scheme of a name in force at a time. Copied verbatim from
-- the helpers in src/sql/; the gate in src/__tests__/hand-written.test.ts
-- holds the file to them.
ALTER TABLE "wms"."planning_area" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "planning_area_tenant_fence" ON "wms"."planning_area" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "planning_area_touch_updated_at" BEFORE UPDATE ON "wms"."planning_area" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."planning_area_boundary" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "planning_area_boundary_tenant_fence" ON "wms"."planning_area_boundary" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "planning_area_boundary_touch_updated_at" BEFORE UPDATE ON "wms"."planning_area_boundary" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_calendar_tenant_fence" ON "wms"."collection_calendar" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_calendar_touch_updated_at" BEFORE UPDATE ON "wms"."collection_calendar" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar_holiday" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_calendar_holiday_tenant_fence" ON "wms"."collection_calendar_holiday" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_calendar_holiday_touch_updated_at" BEFORE UPDATE ON "wms"."collection_calendar_holiday" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "route_scheme_tenant_fence" ON "wms"."route_scheme" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "route_scheme_touch_updated_at" BEFORE UPDATE ON "wms"."route_scheme" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_group" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_group_tenant_fence" ON "wms"."collection_group" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_group_touch_updated_at" BEFORE UPDATE ON "wms"."collection_group" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_group_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_group_fraction_tenant_fence" ON "wms"."collection_group_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_group_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."collection_group_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container_type" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_group_container_type_tenant_fence" ON "wms"."collection_group_container_type" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_group_container_type_touch_updated_at" BEFORE UPDATE ON "wms"."collection_group_container_type" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."collection_group_container" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_group_container_tenant_fence" ON "wms"."collection_group_container" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "collection_group_container_touch_updated_at" BEFORE UPDATE ON "wms"."collection_group_container" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."planning_area_boundary" ADD CONSTRAINT "planning_area_boundary_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "planning_area_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."collection_calendar" ADD CONSTRAINT "collection_calendar_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "project_id" WITH =, "name" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);
