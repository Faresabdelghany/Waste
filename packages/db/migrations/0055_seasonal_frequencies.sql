-- O17 of #290: seasonal frequencies. A Route Scheme's Seasons, each a stretch
-- of every year (month-days, half-open, over the new year where the end comes
-- first) in which the scheme serves its service days at the season's own
-- cadence. Below drizzle-kit's statements: the table's fence and trigger,
-- then its audit trail as part of its scheme's set. Nothing present changes
-- meaning: a scheme with no season runs at its own cadence all year, as
-- every scheme did before.
CREATE TABLE "wms"."route_scheme_season" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route_scheme_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"frequency" text NOT NULL,
	"week_rotation" text,
	CONSTRAINT "route_scheme_season_route_scheme_id_name_key" UNIQUE("company_id","route_scheme_id","name"),
	CONSTRAINT "route_scheme_season_frequency_one_of" CHECK ("wms"."route_scheme_season"."frequency" in ('weekly', 'every-2-weeks', 'every-3-weeks', 'every-4-weeks', 'monthly')),
	CONSTRAINT "route_scheme_season_week_rotation_one_of" CHECK ("wms"."route_scheme_season"."week_rotation" in ('odd', 'even')),
	CONSTRAINT "route_scheme_season_starts_on_shape" CHECK ("wms"."route_scheme_season"."starts_on" ~ '^((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))$'),
	CONSTRAINT "route_scheme_season_ends_on_shape" CHECK ("wms"."route_scheme_season"."ends_on" ~ '^((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))$'),
	CONSTRAINT "route_scheme_season_span" CHECK ("wms"."route_scheme_season"."starts_on" <> "wms"."route_scheme_season"."ends_on"),
	CONSTRAINT "route_scheme_season_week_rotation_shape" CHECK (("wms"."route_scheme_season"."frequency" = 'every-2-weeks') = ("wms"."route_scheme_season"."week_rotation" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."route_scheme_season" ADD CONSTRAINT "route_scheme_season_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme_season" ADD CONSTRAINT "route_scheme_season_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme_season" ADD CONSTRAINT "route_scheme_season_route_scheme_id_fk" FOREIGN KEY ("company_id","project_id","route_scheme_id") REFERENCES "wms"."route_scheme"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_scheme_season_project_id_idx" ON "wms"."route_scheme_season" USING btree ("company_id","project_id");
--> statement-breakpoint
ALTER TABLE "wms"."route_scheme_season" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "route_scheme_season_tenant_fence" ON "wms"."route_scheme_season" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "route_scheme_season_touch_updated_at" BEFORE UPDATE ON "wms"."route_scheme_season" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "route_scheme_season_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."route_scheme_season" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('route_scheme', 'route_scheme_id');
