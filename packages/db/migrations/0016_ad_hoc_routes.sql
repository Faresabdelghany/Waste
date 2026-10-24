-- The ad-hoc Route and the extra Pickup (#111), forward-only: once a route
-- without a scheme or a stop without a container is written, the NOT NULLs
-- this file relaxes cannot come back. Every relaxation is guarded by a check
-- that says which rows may hold the null — `route_scheme_shape` (the scheme
-- and the group together, or neither and no run's) and `pickup_container_shape`
-- (a stop without a container is the office's) — and the one new NOT NULL
-- column, `pickup.origin`, is backfilled by its default: every pickup before
-- this file was generation's, since no other writer of pickups existed. No
-- statement drops or rewrites a value, so unlike 0007's DROP COLUMN there is
-- nothing a DO-block guard would have to prove, and every row already present
-- passes each check by construction (the columns were NOT NULL until here).
ALTER TABLE "wms"."pickup" ALTER COLUMN "container_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."route" ALTER COLUMN "route_scheme_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."route" ALTER COLUMN "collection_group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD COLUMN "origin" text DEFAULT 'generation' NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "recollection_pickup_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_recollection_route_id_recollection_pickup_id_fk" FOREIGN KEY ("company_id","project_id","recollection_route_id","recollection_pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_recollection_pickup_id_idx" ON "wms"."ticket" USING btree ("company_id","recollection_pickup_id");--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_origin_one_of" CHECK ("wms"."pickup"."origin" in ('generation', 'office'));--> statement-breakpoint
ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_container_shape" CHECK ("wms"."pickup"."container_id" is not null or "wms"."pickup"."origin" = 'office');--> statement-breakpoint
ALTER TABLE "wms"."route" ADD CONSTRAINT "route_scheme_shape" CHECK (("wms"."route"."route_scheme_id" is null) = ("wms"."route"."collection_group_id" is null) and ("wms"."route"."route_scheme_id" is not null or ("wms"."route"."generation_run_id" is null and not "wms"."route"."cancelled_by_generation")));--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_recollection_pickup_shape" CHECK ("wms"."ticket"."recollection_pickup_id" is null or "wms"."ticket"."recollection_route_id" is not null);