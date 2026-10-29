-- A weighbridge's tickets (O27 of #290, row 8.8): `weighbridge_ticket`, what a
-- station's weighbridge said of one weighing, kept as itself and matched to
-- the route its vehicle was out on, where it is written as that route's
-- Unload (`source = integration`); a ticket the match found no route for waits
-- for the office with its reason, to be matched by hand or dismissed. Not a
-- ledger, since a match or a dismissal comes after it arrives: below
-- drizzle-kit's statements its fence, its trigger and its audit trail. A new
-- table, so no row present changes meaning.
CREATE TABLE "wms"."weighbridge_ticket" (
	"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unloading_station_id" uuid NOT NULL,
	"ticket_number" text NOT NULL,
	"vehicle_registration" text NOT NULL,
	"vehicle_id" uuid,
	"weighed_at" timestamp with time zone NOT NULL,
	"gross_kg" integer,
	"tare_kg" integer,
	"net_kg" integer NOT NULL,
	"fraction_key" text,
	"waste_code" text,
	"status" text NOT NULL,
	"unmatched_reason" text,
	"route_id" uuid,
	"unload_id" uuid,
	"dismissed_note" text,
	"received_by" uuid NOT NULL,
	CONSTRAINT "weighbridge_ticket_unloading_station_id_ticket_number_key" UNIQUE("company_id","unloading_station_id","ticket_number"),
	CONSTRAINT "weighbridge_ticket_status_one_of" CHECK ("wms"."weighbridge_ticket"."status" in ('matched', 'unmatched', 'dismissed')),
	CONSTRAINT "weighbridge_ticket_unmatched_reason_one_of" CHECK ("wms"."weighbridge_ticket"."unmatched_reason" in ('unknown-vehicle', 'no-route', 'several-routes', 'unknown-fraction', 'fraction-not-accepted')),
	CONSTRAINT "weighbridge_ticket_gross_kg_positive" CHECK ("wms"."weighbridge_ticket"."gross_kg" > 0),
	CONSTRAINT "weighbridge_ticket_tare_kg_positive" CHECK ("wms"."weighbridge_ticket"."tare_kg" > 0),
	CONSTRAINT "weighbridge_ticket_net_kg_positive" CHECK ("wms"."weighbridge_ticket"."net_kg" > 0),
	CONSTRAINT "weighbridge_ticket_weights_shape" CHECK (("wms"."weighbridge_ticket"."gross_kg" is null) = ("wms"."weighbridge_ticket"."tare_kg" is null) and ("wms"."weighbridge_ticket"."gross_kg" is null or "wms"."weighbridge_ticket"."net_kg" = "wms"."weighbridge_ticket"."gross_kg" - "wms"."weighbridge_ticket"."tare_kg")),
	CONSTRAINT "weighbridge_ticket_status_shape" CHECK (("wms"."weighbridge_ticket"."status" = 'matched') = ("wms"."weighbridge_ticket"."route_id" is not null and "wms"."weighbridge_ticket"."unload_id" is not null and "wms"."weighbridge_ticket"."project_id" is not null) and ("wms"."weighbridge_ticket"."status" = 'dismissed') = ("wms"."weighbridge_ticket"."dismissed_note" is not null) and ("wms"."weighbridge_ticket"."status" <> 'unmatched' or "wms"."weighbridge_ticket"."unmatched_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "wms"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_project_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "wms"."project"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_unloading_station_id_fk" FOREIGN KEY ("company_id","unloading_station_id") REFERENCES "wms"."unloading_station"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_vehicle_id_fk" FOREIGN KEY ("company_id","project_id","vehicle_id") REFERENCES "wms"."vehicle"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_route_id_fk" FOREIGN KEY ("company_id","project_id","route_id") REFERENCES "wms"."route"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_unload_id_fk" FOREIGN KEY ("company_id","project_id","unload_id") REFERENCES "wms"."unload"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ADD CONSTRAINT "weighbridge_ticket_received_by_fk" FOREIGN KEY ("company_id","received_by") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_project_id_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_vehicle_id_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_route_id_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","route_id");--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_unload_id_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","unload_id");--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_received_by_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","received_by");--> statement-breakpoint
CREATE INDEX "weighbridge_ticket_status_idx" ON "wms"."weighbridge_ticket" USING btree ("company_id","status","id");--> statement-breakpoint
ALTER TABLE "wms"."weighbridge_ticket" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "weighbridge_ticket_tenant_fence" ON "wms"."weighbridge_ticket" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));
--> statement-breakpoint
CREATE TRIGGER "weighbridge_ticket_touch_updated_at" BEFORE UPDATE ON "wms"."weighbridge_ticket" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER "weighbridge_ticket_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."weighbridge_ticket" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');
