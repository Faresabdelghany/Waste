-- A route's workload (O10 of #290): a waste fraction's density, kg per cubic metre, which a stop's expected weight multiplies its container's litres by, and a container type's service seconds, an emptying's time at the kerb.
-- No table is new, so nothing is hand-written; both columns are nullable and every row present passes the ranges, so nothing is guarded.
ALTER TABLE "wms"."container_type" ADD COLUMN "service_seconds" integer;--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD COLUMN "density_kg_per_cubic_metre" integer;--> statement-breakpoint
ALTER TABLE "wms"."container_type" ADD CONSTRAINT "container_type_service_seconds_range" CHECK ("wms"."container_type"."service_seconds" between 1 and 3600);--> statement-breakpoint
ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_density_kg_per_cubic_metre_range" CHECK ("wms"."waste_fraction"."density_kg_per_cubic_metre" between 1 and 2000);