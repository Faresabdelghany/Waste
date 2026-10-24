-- The stop's service (O3 of #290), as drizzle-kit wrote it: `pickup.service`
-- backfilled `empty` by its default — every stop before it emptied its
-- container — with its vocabulary and two shapes (generation empties; a work
-- order is of a container), and `pickup_route_id_container_id_key` relaxed
-- from a constraint to a unique index over generation's stops alone, so the
-- office may repeat a container on a route. Every row present passes the
-- three checks and the narrower index by construction, so nothing is guarded
-- (migrations/README.md); the relaxation is forward-only, since an office
-- stop repeating a container keeps the old key from coming back.
ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_route_id_container_id_key";--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD COLUMN "service" text DEFAULT 'empty' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_route_id_container_id_key" ON "wms"."pickup" USING btree ("company_id","route_id","container_id") WHERE "wms"."pickup"."origin" = 'generation';--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_one_of" CHECK ("wms"."pickup"."service" in ('empty', 'deliver', 'remove', 'swap', 'repair', 'wash'));--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_origin_shape" CHECK ("wms"."pickup"."service" = 'empty' or "wms"."pickup"."origin" = 'office');--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_container_shape" CHECK ("wms"."pickup"."service" = 'empty' or "wms"."pickup"."container_id" is not null);