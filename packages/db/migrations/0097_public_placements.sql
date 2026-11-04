-- A public placement (M12 of #293): a litter or dog bin the project serves at
-- one of its Shared Collection Points, with no subscription behind it and so
-- no payer. A placement names exactly one of the two: its subscription, as
-- every placement until now, or the point it stands at. drizzle-kit's
-- statements alone: every row stored names a subscription, so the CHECK holds
-- on them as written, and nothing is backfilled or hand-written.
ALTER TABLE "wms"."container_service_placement" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD COLUMN "shared_collection_point_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_service_placement_shared_collection_point_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","shared_collection_point_id");--> statement-breakpoint
ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_served_exactly_one" CHECK (("wms"."container_service_placement"."subscription_id" is not null)::int + ("wms"."container_service_placement"."shared_collection_point_id" is not null)::int = 1);