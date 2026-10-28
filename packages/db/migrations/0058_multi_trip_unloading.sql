-- Multi-trip unloading (O15 of #290): a Plan's stop is a pickup of the Route
-- or an unload visit on the way at its Unloading Station, where the vehicle is
-- full before its last stop. Every row present is a pickup, which the column's
-- default says and the shape check holds; no table is new, so nothing is
-- hand-written.
ALTER TABLE "wms"."plan_stop" ALTER COLUMN "pickup_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD COLUMN "kind" text DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD COLUMN "unloading_station_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_stop_unloading_station_id_idx" ON "wms"."plan_stop" USING btree ("company_id","unloading_station_id");--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_kind_one_of" CHECK ("wms"."plan_stop"."kind" in ('pickup', 'unload'));--> statement-breakpoint
ALTER TABLE "wms"."plan_stop" ADD CONSTRAINT "plan_stop_kind_shape" CHECK (case "wms"."plan_stop"."kind" when 'pickup' then "wms"."plan_stop"."pickup_id" is not null and "wms"."plan_stop"."unloading_station_id" is null else "wms"."plan_stop"."pickup_id" is null and "wms"."plan_stop"."unloading_station_id" is not null and "wms"."plan_stop"."window_warning" is null end);