-- The stop a ticket is answered by (O3c of #290): a container request's delivery, an overflow's emptying, a defect's repair or swap, booked on the ticket as a pickup of its route, both or neither, one ticket per stop.
-- No table is new, so nothing is hand-written; no ticket present names a booking, so nothing is guarded.
ALTER TABLE "wms"."ticket" ADD COLUMN "booked_route_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD COLUMN "booked_pickup_id" uuid;--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_booked_route_id_booked_pickup_id_fk" FOREIGN KEY ("company_id","project_id","booked_route_id","booked_pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_booked_pickup_id_key" ON "wms"."ticket" USING btree ("company_id","booked_pickup_id") WHERE "wms"."ticket"."booked_pickup_id" is not null;--> statement-breakpoint
CREATE INDEX "ticket_booked_route_id_idx" ON "wms"."ticket" USING btree ("company_id","booked_route_id");--> statement-breakpoint
ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_booked_shape" CHECK (("wms"."ticket"."booked_route_id" is null) = ("wms"."ticket"."booked_pickup_id" is null));