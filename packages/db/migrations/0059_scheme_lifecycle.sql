-- A Route Scheme's lifecycle (O21 of #290): the Plan Ahead window as the
-- scheme's setting, `plan_ahead_days`, 7 for every scheme present, which is
-- the week the nightly sweep always planned, and `archived_at`, the mark an
-- archive leaves, null for every scheme present. drizzle-kit wrote the
-- columns and their checks; no table is new, so nothing is hand-written, and
-- every row present passes: none is archived.
ALTER TABLE "wms"."route_scheme" ADD COLUMN "plan_ahead_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_plan_ahead_days_range" CHECK ("wms"."route_scheme"."plan_ahead_days" between 1 and 28);--> statement-breakpoint
ALTER TABLE "wms"."route_scheme" ADD CONSTRAINT "route_scheme_archived_shape" CHECK ("wms"."route_scheme"."archived_at" is null or not "wms"."route_scheme"."plan_ahead");