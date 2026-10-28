-- Live positions (O8 of #290, decided on #344): `session_position`, where a
-- session's vehicle was, one row per fix a `record-positions` command
-- carried, and the driver command's kind grown by it. Below drizzle-kit's
-- statements: the table's fence, the ledger's revoke from the API role, and
-- the one delete path into it, the worker's retention purge (personal
-- location data, #381). No row present changes meaning: no receipt holds the
-- new kind yet.
CREATE TABLE "wms"."session_position" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"fixed_at" timestamp with time zone NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"accuracy_m" integer NOT NULL,
	"speed_kmh" integer,
	"heading_deg" integer,
	CONSTRAINT "session_position_location_valid" CHECK (extensions.st_isvalid("wms"."session_position"."location") and not extensions.st_isempty("wms"."session_position"."location") and extensions.st_xmin("wms"."session_position"."location") >= -180 and extensions.st_xmax("wms"."session_position"."location") <= 180 and extensions.st_ymin("wms"."session_position"."location") >= -90 and extensions.st_ymax("wms"."session_position"."location") <= 90),
	CONSTRAINT "session_position_accuracy_m_positive" CHECK ("wms"."session_position"."accuracy_m" > 0),
	CONSTRAINT "session_position_speed_range" CHECK ("wms"."session_position"."speed_kmh" is null or "wms"."session_position"."speed_kmh" between 0 and 300),
	CONSTRAINT "session_position_heading_range" CHECK ("wms"."session_position"."heading_deg" is null or "wms"."session_position"."heading_deg" between 0 and 359)
);
--> statement-breakpoint
ALTER TABLE "wms"."driver_command" DROP CONSTRAINT "driver_command_kind_one_of";--> statement-breakpoint
ALTER TABLE "wms"."session_position" ADD CONSTRAINT "session_position_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session_position" ADD CONSTRAINT "session_position_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session_position" ADD CONSTRAINT "session_position_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session_position" ADD CONSTRAINT "session_position_route_id_session_id_fk" FOREIGN KEY ("company_id","project_id","route_id","session_id") REFERENCES "wms"."session"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."session_position" ADD CONSTRAINT "session_position_driver_id_fk" FOREIGN KEY ("company_id","project_id","driver_id") REFERENCES "wms"."driver"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_position_session_id_idx" ON "wms"."session_position" USING btree ("company_id","session_id","fixed_at");--> statement-breakpoint
CREATE INDEX "session_position_project_id_idx" ON "wms"."session_position" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "session_position_route_id_idx" ON "wms"."session_position" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "session_position_driver_id_idx" ON "wms"."session_position" USING btree ("company_id","driver_id");--> statement-breakpoint
CREATE INDEX "session_position_fixed_at_idx" ON "wms"."session_position" USING btree ("fixed_at");--> statement-breakpoint
ALTER TABLE "wms"."driver_command" ADD CONSTRAINT "driver_command_kind_one_of" CHECK ("wms"."driver_command"."kind" in ('start-route', 'arrive', 'complete-pickup', 'skip-pickup', 'fail-pickup', 'report-problem', 'add-photo', 'add-weight', 'add-signature', 'add-note', 'record-unload', 'pause', 'resume', 'end-route', 'record-positions'));
--> statement-breakpoint
ALTER TABLE "wms"."session_position" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "session_position_tenant_fence" ON "wms"."session_position" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."session_position" FROM wms_api;
--> statement-breakpoint
GRANT DELETE ON "wms"."session_position" TO wms_worker;
