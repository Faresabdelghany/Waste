CREATE TABLE "wms"."drop_off_point" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"address" text NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"open_always" boolean DEFAULT false NOT NULL,
	"closed_on_holidays" boolean DEFAULT false NOT NULL,
	"public_note" text,
	"status" text NOT NULL,
	"notes" text,
	CONSTRAINT "drop_off_point_project_id_code_key" UNIQUE("company_id","project_id","code"),
	CONSTRAINT "drop_off_point_project_id_name_key" UNIQUE("company_id","project_id","name"),
	CONSTRAINT "drop_off_point_project_key" UNIQUE("company_id","project_id","id"),
	CONSTRAINT "drop_off_point_kind_one_of" CHECK ("wms"."drop_off_point"."kind" in ('recycling-centre', 'bring-bank')),
	CONSTRAINT "drop_off_point_status_one_of" CHECK ("wms"."drop_off_point"."status" in ('draft', 'active', 'closed')),
	CONSTRAINT "drop_off_point_location_valid" CHECK (extensions.st_isvalid("wms"."drop_off_point"."location") and not extensions.st_isempty("wms"."drop_off_point"."location") and extensions.st_xmin("wms"."drop_off_point"."location") >= -180 and extensions.st_xmax("wms"."drop_off_point"."location") <= 180 and extensions.st_ymin("wms"."drop_off_point"."location") >= -90 and extensions.st_ymax("wms"."drop_off_point"."location") <= 90)
);
--> statement-breakpoint
CREATE TABLE "wms"."drop_off_point_exception" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drop_off_point_id" uuid NOT NULL,
	"day" date NOT NULL,
	"opens_at" time,
	"closes_at" time,
	"note" text,
	CONSTRAINT "drop_off_point_exception_day_key" UNIQUE("company_id","drop_off_point_id","day"),
	CONSTRAINT "drop_off_point_exception_window_shape" CHECK (("wms"."drop_off_point_exception"."opens_at" is null) = ("wms"."drop_off_point_exception"."closes_at" is null) and ("wms"."drop_off_point_exception"."opens_at" is null or "wms"."drop_off_point_exception"."opens_at" < "wms"."drop_off_point_exception"."closes_at"))
);
--> statement-breakpoint
CREATE TABLE "wms"."drop_off_point_fraction" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drop_off_point_id" uuid NOT NULL,
	"waste_fraction_id" uuid NOT NULL,
	CONSTRAINT "drop_off_point_fraction_membership_key" UNIQUE("company_id","drop_off_point_id","waste_fraction_id")
);
--> statement-breakpoint
CREATE TABLE "wms"."drop_off_point_hours" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"drop_off_point_id" uuid NOT NULL,
	"weekday" text NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	CONSTRAINT "drop_off_point_hours_weekday_one_of" CHECK ("wms"."drop_off_point_hours"."weekday" in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
	CONSTRAINT "drop_off_point_hours_window_shape" CHECK ("wms"."drop_off_point_hours"."opens_at" < "wms"."drop_off_point_hours"."closes_at")
);
--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point" ADD CONSTRAINT "drop_off_point_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point" ADD CONSTRAINT "drop_off_point_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_exception" ADD CONSTRAINT "drop_off_point_exception_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_exception" ADD CONSTRAINT "drop_off_point_exception_drop_off_point_id_fk" FOREIGN KEY ("company_id","project_id","drop_off_point_id") REFERENCES "wms"."drop_off_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_fraction" ADD CONSTRAINT "drop_off_point_fraction_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_fraction" ADD CONSTRAINT "drop_off_point_fraction_drop_off_point_id_fk" FOREIGN KEY ("company_id","project_id","drop_off_point_id") REFERENCES "wms"."drop_off_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_fraction" ADD CONSTRAINT "drop_off_point_fraction_waste_fraction_id_fk" FOREIGN KEY ("company_id","waste_fraction_id") REFERENCES "wms"."waste_fraction"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_hours" ADD CONSTRAINT "drop_off_point_hours_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_hours" ADD CONSTRAINT "drop_off_point_hours_drop_off_point_id_fk" FOREIGN KEY ("company_id","project_id","drop_off_point_id") REFERENCES "wms"."drop_off_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drop_off_point_fraction_waste_fraction_id_idx" ON "wms"."drop_off_point_fraction" USING btree ("company_id","waste_fraction_id");--> statement-breakpoint
CREATE INDEX "drop_off_point_hours_drop_off_point_id_idx" ON "wms"."drop_off_point_hours" USING btree ("company_id","drop_off_point_id");--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "drop_off_point_tenant_fence" ON "wms"."drop_off_point" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_touch_updated_at" BEFORE UPDATE ON "wms"."drop_off_point" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_fraction" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "drop_off_point_fraction_tenant_fence" ON "wms"."drop_off_point_fraction" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_fraction_touch_updated_at" BEFORE UPDATE ON "wms"."drop_off_point_fraction" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_hours" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "drop_off_point_hours_tenant_fence" ON "wms"."drop_off_point_hours" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_hours_touch_updated_at" BEFORE UPDATE ON "wms"."drop_off_point_hours" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
ALTER TABLE "wms"."drop_off_point_exception" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "drop_off_point_exception_tenant_fence" ON "wms"."drop_off_point_exception" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_exception_touch_updated_at" BEFORE UPDATE ON "wms"."drop_off_point_exception" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."drop_off_point" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_fraction_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."drop_off_point_fraction" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('drop_off_point', 'drop_off_point_id');
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_hours_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."drop_off_point_hours" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('drop_off_point', 'drop_off_point_id');
--> statement-breakpoint
CREATE TRIGGER "drop_off_point_exception_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."drop_off_point_exception" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('drop_off_point', 'drop_off_point_id');
--> statement-breakpoint
GRANT SELECT ("id", "company_id", "project_id", "name", "kind", "address", "location", "open_always", "closed_on_holidays", "public_note", "status") ON "wms"."drop_off_point" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "drop_off_point_id", "waste_fraction_id") ON "wms"."drop_off_point_fraction" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "drop_off_point_id", "weekday", "opens_at", "closes_at") ON "wms"."drop_off_point_hours" TO wms_public;
--> statement-breakpoint
GRANT SELECT ("company_id", "project_id", "drop_off_point_id", "day", "opens_at", "closes_at", "note") ON "wms"."drop_off_point_exception" TO wms_public;
--> statement-breakpoint
CREATE POLICY "drop_off_point_public_door" ON "wms"."drop_off_point" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "drop_off_point"."company_id" and "published"."id" = "drop_off_point"."project_id" and "published"."public_slug" is not null) and "status" = 'active');
--> statement-breakpoint
CREATE POLICY "drop_off_point_fraction_public_door" ON "wms"."drop_off_point_fraction" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "drop_off_point_fraction"."company_id" and "published"."id" = "drop_off_point_fraction"."project_id" and "published"."public_slug" is not null) and exists (select 1 from "wms"."drop_off_point" "point" where "point"."company_id" = "drop_off_point_fraction"."company_id" and "point"."id" = "drop_off_point_fraction"."drop_off_point_id" and "point"."status" = 'active'));
--> statement-breakpoint
CREATE POLICY "drop_off_point_hours_public_door" ON "wms"."drop_off_point_hours" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "drop_off_point_hours"."company_id" and "published"."id" = "drop_off_point_hours"."project_id" and "published"."public_slug" is not null) and exists (select 1 from "wms"."drop_off_point" "point" where "point"."company_id" = "drop_off_point_hours"."company_id" and "point"."id" = "drop_off_point_hours"."drop_off_point_id" and "point"."status" = 'active'));
--> statement-breakpoint
CREATE POLICY "drop_off_point_exception_public_door" ON "wms"."drop_off_point_exception" AS PERMISSIVE FOR SELECT TO wms_public USING ("company_id" = (select wms.current_company_id()) and exists (select 1 from "wms"."project" "published" where "published"."company_id" = "drop_off_point_exception"."company_id" and "published"."id" = "drop_off_point_exception"."project_id" and "published"."public_slug" is not null) and exists (select 1 from "wms"."drop_off_point" "point" where "point"."company_id" = "drop_off_point_exception"."company_id" and "point"."id" = "drop_off_point_exception"."drop_off_point_id" and "point"."status" = 'active'));
