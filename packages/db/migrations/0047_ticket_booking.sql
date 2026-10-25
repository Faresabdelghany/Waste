-- #422: the ticket_booking ledger, every stop a ticket booked, so a stop's
-- outcome heard after its ticket was booked again still finds the ticket.
--
-- Tickets booked before this migration take one row each: the stop their own
-- columns name when it runs, the current booking (src/sql/ticket-booking.ts).
-- A booking a rebooking replaced before it is not recorded, since nothing kept
-- it; the ticket's comments still name it. The backfill runs as the owner,
-- after the table and before its fence and its revoke.
CREATE TABLE "wms"."ticket_booking" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"pickup_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wms"."ticket_booking" ADD CONSTRAINT "ticket_booking_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_booking" ADD CONSTRAINT "ticket_booking_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_booking" ADD CONSTRAINT "ticket_booking_ticket_id_fk" FOREIGN KEY ("company_id","project_id","ticket_id") REFERENCES "wms"."ticket"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."ticket_booking" ADD CONSTRAINT "ticket_booking_route_id_pickup_id_fk" FOREIGN KEY ("company_id","project_id","route_id","pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_booking_pickup_id_key" ON "wms"."ticket_booking" USING btree ("company_id","pickup_id");--> statement-breakpoint
CREATE INDEX "ticket_booking_ticket_id_idx" ON "wms"."ticket_booking" USING btree ("company_id","ticket_id","id");--> statement-breakpoint
CREATE INDEX "ticket_booking_project_id_idx" ON "wms"."ticket_booking" USING btree ("company_id","project_id");
--> statement-breakpoint
INSERT INTO "wms"."ticket_booking" ("company_id", "project_id", "ticket_id", "route_id", "pickup_id") SELECT t."company_id", t."project_id", t."id", t."booked_route_id", t."booked_pickup_id" FROM "wms"."ticket" AS t WHERE t."booked_pickup_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "wms"."ticket_booking" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "ticket_booking_tenant_fence" ON "wms"."ticket_booking" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "wms"."ticket_booking" FROM wms_api;
